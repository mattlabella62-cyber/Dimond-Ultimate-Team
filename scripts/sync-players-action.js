// ═══════════════════════════════════════════════════════
// DiamondUT — Player Sync (GitHub Actions)
// scripts/sync-players-action.js
//
// Runs via GitHub Actions — no timeout limits
// Fetches nflfastR real stats + Sleeper player data
// Saves accurate tiers to Supabase
// ═══════════════════════════════════════════════════════
 
const { createClient } = require('@supabase/supabase-js')
const https = require('https')
const http  = require('http')
 
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
 
// ─── CONSTANTS ─────────────────────────────────────────
const NFL_POSITIONS    = ['QB', 'RB', 'WR', 'TE', 'K']
const MLB_POSITIONS    = ['C', '1B', '2B', '3B', 'SS', 'OF', 'SP', 'RP']
const INJURED_STATUSES = ['Out', 'IR', 'IL', 'PUP', '60-Day IL', 'NFI', 'Suspended']
const TIER_VALUES      = { legendary:200, platinum:100, gold:60, silver:25, bronze:10 }
 
// Valid active NFL teams
const VALID_NFL_TEAMS = [
  'ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN',
  'DET','GB','HOU','IND','JAX','KC','LA','LAC','LV','MIA',
  'MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS'
]
 
// Valid active MLB teams
const VALID_MLB_TEAMS = [
  'ARI','ATL','BAL','BOS','CHC','CWS','CIN','CLE','COL','DET',
  'HOU','KC','LAA','LAD','MIA','MIL','MIN','NYM','NYY','OAK',
  'PHI','PIT','SD','SEA','SF','STL','TB','TEX','TOR','WSH'
]
 
// ─── TIER THRESHOLDS ───────────────────────────────────
const NFL_TIERS = {
  QB:  { legendary:2,  platinum:8,  gold:18, silver:32 },
  RB:  { legendary:3,  platinum:12, gold:28, silver:45 },
  WR:  { legendary:3,  platinum:12, gold:30, silver:50 },
  TE:  { legendary:2,  platinum:8,  gold:18, silver:30 },
  K:   { legendary:2,  platinum:8,  gold:18, silver:28 }
}
 
const MLB_TIERS = {
  C:    { legendary:2, platinum:8,  gold:18, silver:35 },
  '1B': { legendary:2, platinum:8,  gold:18, silver:35 },
  '2B': { legendary:2, platinum:8,  gold:18, silver:35 },
  '3B': { legendary:2, platinum:8,  gold:18, silver:35 },
  SS:   { legendary:2, platinum:8,  gold:18, silver:35 },
  OF:   { legendary:4, platinum:18, gold:45, silver:80 },
  SP:   { legendary:3, platinum:12, gold:30, silver:55 },
  RP:   { legendary:3, platinum:12, gold:30, silver:55 }
}
 
function assignTier(rank, position, sport) {
  const t = sport === 'NFL'
    ? (NFL_TIERS[position] || NFL_TIERS.WR)
    : (MLB_TIERS[position] || MLB_TIERS.OF)
  if (rank <= t.legendary) return 'legendary'
  if (rank <= t.platinum)  return 'platinum'
  if (rank <= t.gold)      return 'gold'
  if (rank <= t.silver)    return 'silver'
  return 'bronze'
}
 
// ─── SCORING ───────────────────────────────────────────
function calcNFLScore(stats) {
  // Half PPR scoring
  return (
    (stats.pass_yd  || 0) * 0.04 +
    (stats.pass_td  || 0) * 4    +
    (stats.pass_int || 0) * -2   +
    (stats.rush_yd  || 0) * 0.1  +
    (stats.rush_td  || 0) * 6    +
    (stats.rec_yd   || 0) * 0.1  +
    (stats.rec_td   || 0) * 6    +
    (stats.rec      || 0) * 0.5  +
    (stats.fum_lost || 0) * -2   +
    // Milestone bonuses
    ((stats.pass_yd || 0) >= 350 ? 3 : 0) +
    ((stats.rush_yd || 0) >= 150 ? 3 : 0) +
    ((stats.rec_yd  || 0) >= 150 ? 3 : 0)
  )
}
 
function calcMLBScore(stats) {
  return (
    (stats.single     || 0) * 1   +
    (stats.double     || 0) * 2   +
    (stats.triple     || 0) * 3   +
    (stats.hr         || 0) * 4   +
    (stats.rbi        || 0) * 1   +
    (stats.r          || 0) * 1   +
    (stats.bb         || 0) * 1   +
    (stats.sb         || 0) * 2   +
    (stats.hbp        || 0) * 1   +
    (stats.so         || 0) * -1  +
    (stats.win        || 0) * 5   +
    (stats.ip         || 0) * 1   +
    (stats.ks         || 0) * 1   +
    (stats.er         || 0) * -1  +
    (stats.bb_allowed || 0) * -0.5+
    (stats.sv         || 0) * 5   +
    (stats.blown_save || 0) * -3  +
    (stats.hold       || 0) * 2   +
    (stats.quality_start ? 3 : 0)
  )
}
 
// ─── HTTP FETCH (no external deps) ─────────────────────
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http
    let data = ''
    const req = protocol.get(url, { headers: { 'User-Agent': 'DiamondUT/1.0' } }, res => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve).catch(reject)
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`))
      }
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
    })
    req.on('error', reject)
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')) })
  })
}
 
// ─── PARSE CSV ─────────────────────────────────────────
function parseCSV(text) {
  const lines   = text.trim().split('\n')
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''))
  const rows    = []
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',')
    const row  = {}
    headers.forEach((h, idx) => {
      const v = (vals[idx] || '').trim().replace(/"/g, '')
      row[h] = v === '' || v === 'NA' ? null : v
    })
    rows.push(row)
  }
  return rows
}
 
// ─── PROCESS NFL ───────────────────────────────────────
async function processNFL() {
  console.log('\n═══ Processing NFL ═══')
 
  const now    = new Date()
  const year   = now.getFullYear()
  const month  = now.getMonth() + 1
  const season = month <= 2 ? year - 1 : year
 
  // Fetch Sleeper players for names/teams/injuries
  console.log('Fetching Sleeper NFL players...')
  const sleeperRaw  = await fetchURL('https://api.sleeper.app/v1/players/nfl')
  const sleeperAll  = JSON.parse(sleeperRaw)
  console.log(`Got ${Object.keys(sleeperAll).length} Sleeper NFL players`)
 
  // Build strict active player map
  const activeSleeper = {}
  Object.values(sleeperAll).forEach(p => {
    if (!p.team || !VALID_NFL_TEAMS.includes(p.team)) return
    if (p.active !== true) return
    if (!p.position || !NFL_POSITIONS.includes(p.position)) return
    if (!p.first_name || !p.last_name) return
    activeSleeper[p.player_id] = p
  })
  console.log(`Active NFL players with valid teams: ${Object.keys(activeSleeper).length}`)
 
  // Try to fetch nflfastR season summary stats
  let statsMap = {}
  for (const s of [season, season - 1]) {
    try {
      console.log(`Fetching nflfastR ${s} season stats...`)
      const url  = `https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_season_${s}.csv`
      const text = await fetchURL(url)
      const rows = parseCSV(text)
      console.log(`Got ${rows.length} rows for ${s}`)
 
      if (rows.length > 50) {
        rows.forEach(row => {
          if (!row.player_id || !row.position) return
          if (!NFL_POSITIONS.includes(row.position)) return
          statsMap[row.player_id] = {
            games:    +row.games       || 1,
            pass_yd:  +row.passing_yards   || 0,
            pass_td:  +row.passing_tds     || 0,
            pass_int: +row.interceptions   || 0,
            rush_yd:  +row.rushing_yards   || 0,
            rush_td:  +row.rushing_tds     || 0,
            rec_yd:   +row.receiving_yards || 0,
            rec_td:   +row.receiving_tds   || 0,
            rec:      +row.receptions      || 0,
            fum_lost: (+row.sack_fumbles_lost || 0) + (+row.rushing_fumbles_lost || 0)
          }
        })
        console.log(`Loaded stats for ${Object.keys(statsMap).length} players`)
        break
      }
    } catch(e) {
      console.log(`nflfastR ${s} failed: ${e.message}`)
    }
  }
 
  // Score and rank each active player
  const scored = Object.values(activeSleeper).map(p => {
    const stats     = statsMap[p.player_id] || {}
    const games     = stats.games || 0
    const totalPts  = calcNFLScore(stats)
    const avgPts    = games > 0 ? totalPts / games : 0
 
    return {
      sleeper_id:     p.player_id,
      name:           `${p.first_name} ${p.last_name}`,
      position:       p.position,
      team:           p.team,
      sport:          'NFL',
      is_injured:     INJURED_STATUSES.includes(p.injury_status),
      seasonTotalPts: Math.round(totalPts * 100) / 100,
      seasonAvgPts:   Math.round(avgPts * 100) / 100,
      games,
      search_rank:    p.search_rank || 999999,
      headshot_url:   `https://sleepercdn.com/content/nfl/players/thumb/${p.player_id}.jpg`
    }
  })
 
  // Rank by real stats if available, else search_rank
  const hasRealStats = scored.some(p => p.seasonAvgPts > 0)
  console.log(`Has real stats: ${hasRealStats}`)
 
  return rankAndTier(scored, 'NFL', !hasRealStats)
}
 
// ─── PROCESS MLB ───────────────────────────────────────
async function processMLB() {
  console.log('\n═══ Processing MLB ═══')
 
  const now    = new Date()
  const year   = now.getFullYear()
  const month  = now.getMonth() + 1
  const season = year
 
  // Fetch Sleeper MLB players
  console.log('Fetching Sleeper MLB players...')
  const sleeperRaw = await fetchURL('https://api.sleeper.app/v1/players/mlb')
  const sleeperAll = JSON.parse(sleeperRaw)
  console.log(`Got ${Object.keys(sleeperAll).length} Sleeper MLB players`)
 
  const activeSleeper = {}
  Object.values(sleeperAll).forEach(p => {
    if (!p.team || !VALID_MLB_TEAMS.includes(p.team)) return
    if (p.active !== true) return
    if (!p.position || !MLB_POSITIONS.includes(p.position)) return
    if (!p.first_name || !p.last_name) return
    activeSleeper[p.player_id] = p
  })
  console.log(`Active MLB players with valid teams: ${Object.keys(activeSleeper).length}`)
 
  // Try baseballr / nflverse equivalent for MLB
  // For now use Sleeper search_rank — will add baseballr stats later
  const scored = Object.values(activeSleeper).map(p => ({
    sleeper_id:     p.player_id,
    name:           `${p.first_name} ${p.last_name}`,
    position:       p.position,
    team:           p.team,
    sport:          'MLB',
    is_injured:     INJURED_STATUSES.includes(p.injury_status),
    seasonTotalPts: 0,
    seasonAvgPts:   0,
    games:          0,
    search_rank:    p.search_rank || 999999,
    headshot_url:   `https://sleepercdn.com/content/mlb/players/thumb/${p.player_id}.jpg`
  }))
 
  return rankAndTier(scored, 'MLB', true)
}
 
// ─── RANK AND ASSIGN TIERS ─────────────────────────────
function rankAndTier(players, sport, useSearchRank) {
  const positions = sport === 'NFL' ? NFL_POSITIONS : MLB_POSITIONS
  const ranked    = []
 
  for (const pos of positions) {
    const atPos = players
      .filter(p => p.position === pos)
      .sort((a, b) => useSearchRank
        ? (a.search_rank || 999999) - (b.search_rank || 999999)
        : b.seasonAvgPts - a.seasonAvgPts
      )
 
    console.log(`${pos}: ${atPos.length} active players`)
 
    atPos.forEach((p, idx) => {
      const tier = assignTier(idx + 1, pos, sport)
      ranked.push({
        sleeper_id:       p.sleeper_id,
        name:             p.name,
        position:         p.position,
        team:             p.team,
        sport,
        tier,
        tier_value:       TIER_VALUES[tier],
        projected_points: p.seasonAvgPts || 0,
        actual_points:    p.seasonTotalPts || 0,
        is_injured:       p.is_injured || false,
        is_sleeper:       false,
        is_upside:        false,
        headshot_url:     p.headshot_url,
        updated_at:       new Date().toISOString()
      })
    })
  }
 
  return ranked
}
 
// ─── SAVE TO SUPABASE ───────────────────────────────────
async function saveToSupabase(players) {
  console.log(`\nSaving ${players.length} players to Supabase...`)
 
  const seen = new Map()
  players.forEach(p => seen.set(p.sleeper_id, p))
  const deduped = Array.from(seen.values())
 
  const batchSize = 250
  for (let i = 0; i < deduped.length; i += batchSize) {
    const batch = deduped.slice(i, i + batchSize)
    const { error } = await supabase
      .from('players')
      .upsert(batch, { onConflict: 'sleeper_id', ignoreDuplicates: false })
    if (error) throw new Error(`Batch ${i} error: ${error.message}`)
    console.log(`Saved ${i + batch.length} / ${deduped.length}`)
  }
 
  console.log('✅ All players saved!')
}
 
// ─── MAIN ──────────────────────────────────────────────
async function main() {
  console.log('🏈 DiamondUT Player Sync Starting...')
  console.log(`Time: ${new Date().toISOString()}`)
 
  try {
    const nflRanked = await processNFL()
    const mlbRanked = await processMLB()
 
    await saveToSupabase([...nflRanked, ...mlbRanked])
 
    // Print summary
    const nflBreakdown = {}, mlbBreakdown = {}
    nflRanked.forEach(p => { nflBreakdown[p.tier] = (nflBreakdown[p.tier]||0)+1 })
    mlbRanked.forEach(p => { mlbBreakdown[p.tier] = (mlbBreakdown[p.tier]||0)+1 })
 
    console.log('\n═══ RESULTS ═══')
    console.log(`NFL: ${nflRanked.length} players`, nflBreakdown)
    console.log(`MLB: ${mlbRanked.length} players`, mlbBreakdown)
 
    const nflLeg = nflRanked.filter(p => p.tier === 'legendary')
    const mlbLeg = mlbRanked.filter(p => p.tier === 'legendary')
 
    console.log('\nNFL Legendaries:')
    nflLeg.forEach(p => console.log(`  ${p.name} (${p.position}) ${p.team} — ${p.projected_points}ppg`))
 
    console.log('\nMLB Legendaries:')
    mlbLeg.forEach(p => console.log(`  ${p.name} (${p.position}) ${p.team}`))
 
    console.log('\n✅ Sync complete!')
    process.exit(0)
 
  } catch(err) {
    console.error('❌ Sync failed:', err)
    process.exit(1)
  }
}
 
main()
 

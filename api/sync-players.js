// ═══════════════════════════════════════════════════════
// DiamondUT — Player Sync v4
// api/sync-players.js
//
// Data sources:
//   NFL Stats  → nflverse/nflverse-data (GitHub, open source, free)
//   MLB Stats  → (placeholder until baseballr integrated)
//   Player IDs → Sleeper public player endpoint (documented, free)
//
// Flow:
//   1. Fetch real 2025 NFL stats from nflfastR CSV
//   2. Fetch Sleeper player list for names/teams/injuries
//   3. Match players by name/team
//   4. Run through DiamondUT ranking engine
//   5. Save to Supabase
// ═══════════════════════════════════════════════════════
 
const { createClient } = require('@supabase/supabase-js')
const { calcNFLScore, assignTier, isActivePlayer, TIER_VALUES, NFL_SCORING, MLB_SCORING_DEFAULT } = require('./ranking-engine')
 
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)
 
const NFL_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K']
const MLB_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'OF', 'SP', 'RP']
const INJURED_STATUSES = ['Out', 'IR', 'IL', 'PUP', '60-Day IL', 'NFI', 'Suspended']
 
// ─── FETCH AND PARSE CSV ───────────────────────────────
async function fetchCSV(url) {
  console.log(`Fetching CSV: ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`CSV fetch failed: ${res.status} ${url}`)
  const text = await res.text()
 
  // Parse CSV
  const lines  = text.trim().split('\n')
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''))
 
  const rows = []
  for (let i = 1; i < lines.length; i++) {
    const vals = parseCSVLine(lines[i])
    if (vals.length !== headers.length) continue
    const row = {}
    headers.forEach((h, idx) => {
      const v = vals[idx]?.trim().replace(/"/g, '')
      row[h] = v === '' || v === 'NA' ? null : v
    })
    rows.push(row)
  }
 
  console.log(`Parsed ${rows.length} rows`)
  return rows
}
 
// Handle quoted CSV fields
function parseCSVLine(line) {
  const result = []
  let current  = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuotes = !inQuotes
    } else if (line[i] === ',' && !inQuotes) {
      result.push(current)
      current = ''
    } else {
      current += line[i]
    }
  }
  result.push(current)
  return result
}
 
// ─── FETCH SLEEPER PLAYERS ─────────────────────────────
async function fetchSleeperPlayers(sport) {
  const url = `https://api.sleeper.app/v1/players/${sport.toLowerCase()}`
  console.log(`Fetching Sleeper ${sport} players...`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Sleeper fetch failed: ${res.status}`)
  const data = await res.json()
  console.log(`Got ${Object.keys(data).length} Sleeper ${sport} players`)
  return data
}
 
// ─── PROCESS NFL WITH nflfastR DATA ────────────────────
async function processNFL() {
  console.log('\n═══ Processing NFL ═══')
 
  // Dynamic year — NFL season Sept-Feb
  const now   = new Date()
  const year  = now.getFullYear()
  const month = now.getMonth() + 1
  const nflSeason = month <= 2 ? year - 1 : year
 
  // Fetch nflfastR player stats CSV
  // Falls back to previous season if current not available
  let statsRows = []
  for (const season of [nflSeason, nflSeason - 1]) {
    try {
      const url = `https://github.com/nflverse/nflverse-data/releases/download/player_stats/player_stats_${season}.csv`
      statsRows = await fetchCSV(url)
      if (statsRows.length > 100) {
        console.log(`Using NFL ${season} stats (${statsRows.length} rows)`)
        break
      }
    } catch(e) {
      console.log(`NFL ${season} stats not available: ${e.message}`)
    }
  }
 
  if (statsRows.length === 0) {
    console.log('No NFL stats available — using position-based ranking only')
  }
 
  // Aggregate stats by player (season totals)
  // nflfastR columns: player_id, player_name, position, recent_team,
  //   completions, attempts, passing_yards, passing_tds, interceptions,
  //   carries, rushing_yards, rushing_tds,
  //   receptions, targets, receiving_yards, receiving_tds,
  //   sacks, passing_2pt_conversions, rushing_2pt_conversions,
  //   receiving_2pt_conversions, fantasy_points, fantasy_points_ppr
  const statsByPlayer = {}
  for (const row of statsRows) {
    const pid  = row.player_id
    const pos  = row.position
    if (!pid || !NFL_POSITIONS.includes(pos)) continue
 
    if (!statsByPlayer[pid]) {
      statsByPlayer[pid] = {
        player_id:   pid,
        player_name: row.player_display_name || row.player_name,
        position:    pos,
        team:        row.recent_team,
        games:       0,
        // Passing
        pass_yd: 0, pass_td: 0, pass_int: 0, pass_2pt: 0,
        // Rushing
        rush_yd: 0, rush_td: 0, rush_2pt: 0,
        // Receiving
        rec_yd: 0, rec_td: 0, rec: 0, rec_2pt: 0,
        // Misc
        fum_lost: 0,
        // Kicker
        fg_made_0_39: 0, fg_made_40_49: 0, fg_made_50_59: 0, fg_made_60_plus: 0,
        fg_miss: 0, pat_made: 0, pat_miss: 0,
        // Fantasy totals (for cross-check)
        fantasy_pts_std: 0,
        fantasy_pts_ppr: 0
      }
    }
 
    const p = statsByPlayer[pid]
    p.games       += 1
    p.team         = row.recent_team || p.team // update to most recent team
 
    // Passing
    p.pass_yd  += parseFloat(row.passing_yards  || 0)
    p.pass_td  += parseFloat(row.passing_tds    || 0)
    p.pass_int += parseFloat(row.interceptions  || 0)
    p.pass_2pt += parseFloat(row.passing_2pt_conversions || 0)
 
    // Rushing
    p.rush_yd  += parseFloat(row.rushing_yards  || 0)
    p.rush_td  += parseFloat(row.rushing_tds    || 0)
    p.rush_2pt += parseFloat(row.rushing_2pt_conversions || 0)
 
    // Receiving
    p.rec_yd   += parseFloat(row.receiving_yards || 0)
    p.rec_td   += parseFloat(row.receiving_tds   || 0)
    p.rec      += parseFloat(row.receptions      || 0)
    p.rec_2pt  += parseFloat(row.receiving_2pt_conversions || 0)
 
    // Misc
    p.fum_lost += parseFloat(row.sack_fumbles_lost || 0) + parseFloat(row.rushing_fumbles_lost || 0)
 
    // Fantasy point totals
    p.fantasy_pts_std += parseFloat(row.fantasy_points     || 0)
    p.fantasy_pts_ppr += parseFloat(row.fantasy_points_ppr || 0)
  }
 
  console.log(`Aggregated stats for ${Object.keys(statsByPlayer).length} NFL players`)
 
  // Fetch Sleeper players for names, injury status, Sleeper IDs
  const sleeperPlayers = await fetchSleeperPlayers('nfl')
 
  // Build name → sleeper player map for matching
  const nameToSleeper = {}
  Object.values(sleeperPlayers).forEach(p => {
    if (!p.first_name || !p.last_name) return
    const key = `${p.first_name} ${p.last_name}`.toLowerCase().replace(/[^a-z ]/g, '')
    nameToSleeper[key] = p
  })
 
  // Score each player using our ranking engine
  const scored = []
  const scoring = NFL_SCORING.half_ppr
 
  for (const [pid, stats] of Object.entries(statsByPlayer)) {
    if (!stats.team || stats.team === '' || stats.games === 0) continue
 
    // Match to Sleeper player
    const nameKey = (stats.player_name || '').toLowerCase().replace(/[^a-z ]/g, '')
    const sleeper = nameToSleeper[nameKey]
 
    // Skip if injured/inactive in Sleeper
    const isInjured = sleeper ? INJURED_STATUSES.includes(sleeper.injury_status) : false
    const sleeperTeam = sleeper?.team || stats.team
 
    // Skip FA players (retired/unsigned)
    if (sleeperTeam === 'FA' || sleeperTeam === '') continue
 
    // Calculate DiamondUT score using real stats
    const seasonPts = calcNFLScore(stats, scoring)
    const avgPts    = stats.games > 0 ? seasonPts / stats.games : 0
 
    scored.push({
      sleeper_id:       sleeper?.player_id || `nfl_${pid}`,
      name:             stats.player_name,
      position:         stats.position,
      team:             sleeperTeam,
      sport:            'NFL',
      is_injured:       isInjured,
      seasonTotalPts:   Math.round(seasonPts * 100) / 100,
      seasonAvgPts:     Math.round(avgPts * 100) / 100,
      games:            stats.games,
      headshot_url:     sleeper ? `https://sleepercdn.com/content/nfl/players/thumb/${sleeper.player_id}.jpg` : null
    })
  }
 
  // If we had no stats data, fall back to Sleeper position ranking
  if (scored.length < 50) {
    console.log('Falling back to Sleeper position ranking...')
    return processNFLFallback(sleeperPlayers)
  }
 
  // Rank by position using real season points
  return rankAndAssignTiers(scored, 'NFL')
}
 
// Fallback: use Sleeper search_rank when no stats available
function processNFLFallback(sleeperPlayers) {
  const active = Object.values(sleeperPlayers).filter(p => {
    if (!p.team || p.team === 'FA' || p.team === '') return false
    if (p.active === false) return false
    if (!p.position || !NFL_POSITIONS.includes(p.position)) return false
    if (!p.first_name || !p.last_name) return false
    return true
  })
 
  const scored = active.map(p => ({
    sleeper_id:     p.player_id,
    name:           `${p.first_name} ${p.last_name}`,
    position:       p.position,
    team:           p.team,
    sport:          'NFL',
    is_injured:     INJURED_STATUSES.includes(p.injury_status),
    seasonTotalPts: 0,
    seasonAvgPts:   0,
    games:          0,
    search_rank:    p.search_rank || 999999,
    headshot_url:   `https://sleepercdn.com/content/nfl/players/thumb/${p.player_id}.jpg`
  }))
 
  return rankAndAssignTiers(scored, 'NFL', true)
}
 
// ─── PROCESS MLB (position-based for now) ──────────────
// baseballr integration coming — same pattern as nflfastR
async function processMLB() {
  console.log('\n═══ Processing MLB ═══')
  const sleeperPlayers = await fetchSleeperPlayers('mlb')
 
  const active = Object.values(sleeperPlayers).filter(p => {
    if (!p.team || p.team === 'FA' || p.team === '') return false
    if (p.active === false) return false
    if (!p.position || !MLB_POSITIONS.includes(p.position)) return false
    if (!p.first_name || !p.last_name) return false
    return true
  })
 
  console.log(`Active MLB players: ${active.length}`)
 
  const scored = active.map(p => ({
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
 
  return rankAndAssignTiers(scored, 'MLB', true)
}
 
// ─── RANK AND ASSIGN TIERS ─────────────────────────────
function rankAndAssignTiers(players, sport, useSearchRank = false) {
  const positions = sport === 'NFL' ? NFL_POSITIONS : MLB_POSITIONS
  const ranked    = []
 
  for (const pos of positions) {
    const atPos = players.filter(p => p.position === pos)
 
    // Sort by real stats if available, otherwise search_rank
    atPos.sort((a, b) => {
      if (useSearchRank) {
        return (a.search_rank || 999999) - (b.search_rank || 999999)
      }
      return b.seasonAvgPts - a.seasonAvgPts
    })
 
    console.log(`${pos}: ${atPos.length} players`)
 
    atPos.forEach((p, idx) => {
      const rank = idx + 1
      const tier = assignTier(rank, pos, sport)
 
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
  console.log(`After dedup: ${deduped.length} unique players`)
 
  const batchSize = 250
  for (let i = 0; i < deduped.length; i += batchSize) {
    const batch = deduped.slice(i, i + batchSize)
    const { error } = await supabase
      .from('players')
      .upsert(batch, { onConflict: 'sleeper_id', ignoreDuplicates: false })
    if (error) throw new Error(`Batch ${i} failed: ${error.message}`)
    console.log(`Saved ${i + batch.length} / ${deduped.length}`)
  }
}
 
// ─── MAIN HANDLER ───────────────────────────────────────
module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.PIPELINE_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
 
  try {
    console.log('Starting DiamondUT player sync v4...')
 
    const [nflRanked, mlbRanked] = await Promise.all([
      processNFL(),
      processMLB()
    ])
 
    await saveToSupabase([...nflRanked, ...mlbRanked])
 
    // Tier breakdowns
    const nflBreakdown = {}, mlbBreakdown = {}
    nflRanked.forEach(p => { nflBreakdown[p.tier] = (nflBreakdown[p.tier]||0)+1 })
    mlbRanked.forEach(p => { mlbBreakdown[p.tier] = (mlbBreakdown[p.tier]||0)+1 })
 
    // Top players per sport
    const nflLegendary = nflRanked.filter(p => p.tier === 'legendary').map(p => `${p.name} (${p.position}) ${p.projected_points}pts/gm`)
    const mlbLegendary = mlbRanked.filter(p => p.tier === 'legendary').map(p => `${p.name} (${p.position})`)
 
    console.log('\nNFL Legendaries:', nflLegendary)
    console.log('MLB Legendaries:', mlbLegendary)
 
    return res.status(200).json({
      success:       true,
      nfl_count:     nflRanked.length,
      mlb_count:     mlbRanked.length,
      total:         nflRanked.length + mlbRanked.length,
      nfl_breakdown: nflBreakdown,
      mlb_breakdown: mlbBreakdown,
      nfl_legendary: nflLegendary,
      mlb_legendary: mlbLegendary
    })
 
  } catch(err) {
    console.error('Sync error:', err)
    return res.status(500).json({ error: err.message })
  }
}

// ═══════════════════════════════════════════════════════
// DiamondUT — Player Sync
// api/sync-players.js
//
// Pulls player data from Sleeper, runs it through
// the DiamondUT ranking engine, saves to Supabase.
// Runs every Monday 6am via Vercel cron.
// Never needs manual updates — fully dynamic.
// ═══════════════════════════════════════════════════════

const { createClient } = require('@supabase/supabase-js')
const { rankPlayers, getCurrentSeasons, NFL_SCORING, MLB_SCORING_DEFAULT } = require('./ranking-engine')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const NFL_POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K']
const MLB_POSITIONS = ['C', '1B', '2B', '3B', 'SS', 'OF', 'SP', 'RP']

// ─── FETCH ALL PLAYERS FROM SLEEPER ────────────────────
async function fetchPlayers(sport) {
  const url = `https://api.sleeper.app/v1/players/${sport.toLowerCase()}`
  console.log(`Fetching ${sport} players from Sleeper...`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${sport} players: ${res.status}`)
  const data = await res.json()
  console.log(`Got ${Object.keys(data).length} ${sport} players`)
  return data
}

// ─── FETCH SEASON STATS ────────────────────────────────
// Tries current season first, falls back to previous
async function fetchSeasonStats(sport, season) {
  try {
    const url = `https://api.sleeper.app/v1/stats/${sport.toLowerCase()}/${season}?season_type=regular`
    console.log(`Fetching ${sport} ${season} season stats...`)
    const res = await fetch(url)
    if (!res.ok) {
      console.log(`No ${season} stats found, trying ${season - 1}...`)
      return fetchSeasonStats(sport, season - 1)
    }
    const data = await res.json()
    if (!data || Object.keys(data).length < 50) {
      console.log(`${season} stats too sparse, falling back to ${season - 1}...`)
      return fetchSeasonStats(sport, season - 1)
    }
    console.log(`Got ${Object.keys(data).length} ${sport} player stats for ${season}`)
    return data
  } catch(e) {
    console.log(`Stats error for ${sport} ${season}:`, e.message)
    return {}
  }
}

// ─── FETCH RECENT STATS (last 3 weeks) ─────────────────
async function fetchRecentStats(sport, season, currentWeek) {
  const recentStats = {}
  const weeksToFetch = [
    Math.max(1, currentWeek - 2),
    Math.max(1, currentWeek - 1),
    currentWeek
  ]

  for (const week of weeksToFetch) {
    try {
      const url = `https://api.sleeper.app/v1/stats/${sport.toLowerCase()}/${season}/${week}?season_type=regular`
      const res = await fetch(url)
      if (!res.ok) continue
      const weekData = await res.json()

      // Aggregate into recentStats
      Object.entries(weekData || {}).forEach(([playerId, stats]) => {
        if (!recentStats[playerId]) {
          recentStats[playerId] = { gp: 0 }
        }
        Object.entries(stats).forEach(([stat, val]) => {
          if (stat !== 'gp') {
            recentStats[playerId][stat] = (recentStats[playerId][stat] || 0) + (val || 0)
          }
        })
        recentStats[playerId].gp += 1
      })
    } catch(e) {
      console.log(`Week ${week} stats error:`, e.message)
    }
  }

  console.log(`Got recent stats for ${Object.keys(recentStats).length} players`)
  return recentStats
}

// ─── BUILD MATCHUP DATA ─────────────────────────────────
// Neutral matchup scores for now (50 = neutral)
// In future this will use opponent defensive rankings
async function buildMatchupData(sport, season, week) {
  // Default neutral matchup for all players
  // TODO: enhance with opponent defensive rankings
  return {}  // empty = engine uses 50 (neutral) for all
}

// ─── SAVE TO SUPABASE ───────────────────────────────────
async function saveToSupabase(players) {
  console.log(`Saving ${players.length} players to Supabase...`)

  // Deduplicate by sleeper_id
  const seen = new Map()
  players.forEach(p => seen.set(p.sleeper_id || p.player_id, p))
  const deduped = Array.from(seen.values())

  // Map to DB schema
  const rows = deduped.map(p => ({
    sleeper_id:       p.player_id || p.sleeper_id,
    name:             p.name,
    position:         p.position,
    team:             p.team,
    sport:            p.sport,
    tier:             p.tier,
    tier_value:       p.tier_value,
    projected_points: p.projected_points || 0,
    actual_points:    p.seasonTotalPts   || 0,
    is_injured:       p.is_injured       || false,
    is_sleeper:       p.is_sleeper       || false,
    is_upside:        p.is_upside        || false,
    headshot_url:     p.headshot_url,
    updated_at:       new Date().toISOString()
  }))

  // Save in batches of 250
  const batchSize = 250
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize)
    const { error } = await supabase
      .from('players')
      .upsert(batch, { onConflict: 'sleeper_id', ignoreDuplicates: false })
    if (error) throw new Error(`Batch ${i} failed: ${error.message}`)
    console.log(`Saved ${i + batch.length} / ${rows.length}`)
  }

  console.log(`Successfully saved ${rows.length} players`)
}

// ─── MAIN HANDLER ───────────────────────────────────────
module.exports = async function handler(req, res) {
  // Auth check
  const authHeader = req.headers.authorization
  if (authHeader !== `Bearer ${process.env.PIPELINE_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const seasons = getCurrentSeasons()
    console.log('Season info:', seasons)

    // ── PROCESS NFL ──
    console.log('\n═══ Processing NFL ═══')
    const nflPlayers    = await fetchPlayers('nfl')
    const nflSeasonStats  = await fetchSeasonStats('nfl', seasons.nflSeason)
    const nflRecentStats  = await fetchRecentStats('nfl', seasons.nflSeason, seasons.nflWeek)
    const nflMatchupData  = await buildMatchupData('nfl', seasons.nflSeason, seasons.nflWeek)

    const nflPlayerArr = Object.values(nflPlayers).filter(p =>
      p.position && NFL_POSITIONS.includes(p.position)
    )

    // Rank for both modes — weekly used for packs/tiers, daily for daily contests
    const rankedNFL_weekly = rankPlayers(nflPlayerArr, nflSeasonStats, nflRecentStats, nflMatchupData, 'NFL', 'half_ppr', 'weekly')
    const rankedNFL = rankedNFL_weekly // primary ranking stored in DB

    console.log(`Ranked ${rankedNFL.length} NFL players`)

    // ── PROCESS MLB ──
    console.log('\n═══ Processing MLB ═══')
    const mlbPlayers      = await fetchPlayers('mlb')
    const mlbSeasonStats  = await fetchSeasonStats('mlb', seasons.mlbSeason)
    const mlbRecentStats  = await fetchRecentStats('mlb', seasons.mlbSeason, seasons.mlbWeek)
    const mlbMatchupData  = await buildMatchupData('mlb', seasons.mlbSeason, seasons.mlbWeek)

    const mlbPlayerArr = Object.values(mlbPlayers).filter(p =>
      p.position && MLB_POSITIONS.includes(p.position)
    )

    const rankedMLB = rankPlayers(mlbPlayerArr, mlbSeasonStats, mlbRecentStats, mlbMatchupData, 'MLB', MLB_SCORING_DEFAULT, 'weekly')

    console.log(`Ranked ${rankedMLB.length} MLB players`)

    // ── SAVE ALL ──
    const allPlayers = [
      ...rankedNFL.map(p => ({ ...p, sport: 'NFL' })),
      ...rankedMLB.map(p => ({ ...p, sport: 'MLB' }))
    ]

    await saveToSupabase(allPlayers)

    // ── TIER BREAKDOWN ──
    const nflBreakdown = {}
    const mlbBreakdown = {}
    rankedNFL.forEach(p => { nflBreakdown[p.tier] = (nflBreakdown[p.tier]||0)+1 })
    rankedMLB.forEach(p => { mlbBreakdown[p.tier] = (mlbBreakdown[p.tier]||0)+1 })

    console.log('\nNFL tiers:', nflBreakdown)
    console.log('MLB tiers:', mlbBreakdown)

    return res.status(200).json({
      success:       true,
      nfl_count:     rankedNFL.length,
      mlb_count:     rankedMLB.length,
      total:         allPlayers.length,
      nfl_season:    seasons.nflSeason,
      mlb_season:    seasons.mlbSeason,
      nfl_week:      seasons.nflWeek,
      mlb_week:      seasons.mlbWeek,
      nfl_breakdown: nflBreakdown,
      mlb_breakdown: mlbBreakdown
    })

  } catch(err) {
    console.error('Sync error:', err)
    return res.status(500).json({ error: err.message })
  }
}

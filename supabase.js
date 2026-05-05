// ═══════════════════════════════════
// DiamondUT — Supabase Connection
// Add this file to your GitHub repo
// Every page imports this to talk to
// your database
// ═══════════════════════════════════
 
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm'
 
// These values come from your Supabase project
// Settings → API → Project URL + anon public key
const SUPABASE_URL = 'https://YOUR_PROJECT_URL.supabase.co'
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY'
 
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
 
// ═══════════════════════════════════
// AUTH HELPERS
// ═══════════════════════════════════
 
// Sign up a new user
export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password })
  if (error) throw error
  return data
}
 
// Log in
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw error
  return data
}
 
// Log out
export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw error
}
 
// Get current logged in user
export async function getCurrentUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}
 
// ═══════════════════════════════════
// TEAM HELPERS
// ═══════════════════════════════════
 
// Get the current user's team in a league
export async function getMyTeam(leagueId) {
  const user = await getCurrentUser()
  if (!user) return null
 
  const { data, error } = await supabase
    .from('teams')
    .select('*')
    .eq('user_id', user.id)
    .eq('league_id', leagueId)
    .single()
 
  if (error) throw error
  return data
}
 
// Get all teams in a league (for standings)
export async function getLeagueTeams(leagueId) {
  const { data, error } = await supabase
    .from('teams')
    .select('*')
    .eq('league_id', leagueId)
    .order('wins', { ascending: false })
 
  if (error) throw error
  return data
}
 
// Update team coins
export async function updateCoins(teamId, newAmount) {
  const { data, error } = await supabase
    .from('teams')
    .update({ coins: newAmount })
    .eq('id', teamId)
 
  if (error) throw error
  return data
}
 
// ═══════════════════════════════════
// ROSTER HELPERS
// ═══════════════════════════════════
 
// Get a team's full roster
export async function getRoster(teamId) {
  const { data, error } = await supabase
    .from('rosters')
    .select(`
      *,
      players (
        id, name, position, team, sport, tier,
        tier_value, projected_points, actual_points,
        is_injured, is_sleeper, is_upside, headshot_url
      )
    `)
    .eq('team_id', teamId)
    .eq('is_active', true)
 
  if (error) throw error
  return data
}
 
// Add player to roster
export async function addToRoster(teamId, playerId, leagueId, slot) {
  const { data, error } = await supabase
    .from('rosters')
    .insert({
      team_id: teamId,
      player_id: playerId,
      league_id: leagueId,
      slot: slot,
      is_active: true
    })
 
  if (error) throw error
  return data
}
 
// Drop player from roster
export async function dropFromRoster(teamId, playerId) {
  const { data, error } = await supabase
    .from('rosters')
    .update({ is_active: false })
    .eq('team_id', teamId)
    .eq('player_id', playerId)
 
  if (error) throw error
  return data
}
 
// ═══════════════════════════════════
// PLAYER HELPERS
// ═══════════════════════════════════
 
// Get all players by tier
export async function getPlayersByTier(tier, sport = 'MLB') {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('tier', tier)
    .eq('sport', sport)
    .eq('is_injured', false)
    .order('projected_points', { ascending: false })
 
  if (error) throw error
  return data
}
 
// Get players not on any roster (for FA pool)
export async function getUnrosteredPlayers(leagueId, sport = 'MLB') {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('sport', sport)
    .not('id', 'in', `(
      select player_id from rosters
      where league_id = '${leagueId}'
      and is_active = true
    )`)
    .order('projected_points', { ascending: false })
 
  if (error) throw error
  return data
}
 
// ═══════════════════════════════════
// AUCTION HELPERS
// ═══════════════════════════════════
 
// Get this week's auction pool
export async function getAuctionPool(leagueId, weekNumber) {
  const { data, error } = await supabase
    .from('auction_pool')
    .select(`
      *,
      players (
        id, name, position, team, sport, tier,
        tier_value, projected_points, is_sleeper, is_upside
      )
    `)
    .eq('league_id', leagueId)
    .eq('week_number', weekNumber)
    .eq('is_active', true)
 
  if (error) throw error
  return data
}
 
// Place a blind bid
export async function placeBid(auctionPoolId, teamId, leagueId, amount) {
  const { data, error } = await supabase
    .from('bids')
    .upsert({
      auction_pool_id: auctionPoolId,
      team_id: teamId,
      league_id: leagueId,
      amount: amount
    }, { onConflict: 'auction_pool_id,team_id' })
 
  if (error) throw error
  return data
}
 
// Get your own bids (never shows other teams' bids)
export async function getMyBids(teamId, leagueId) {
  const { data, error } = await supabase
    .from('bids')
    .select(`
      *,
      auction_pool (
        *,
        players ( id, name, position, team, tier )
      )
    `)
    .eq('team_id', teamId)
    .eq('league_id', leagueId)
 
  if (error) throw error
  return data
}
 
// ═══════════════════════════════════
// FREE AGENT HELPERS
// ═══════════════════════════════════
 
// Get available free agents
export async function getFreeAgents(leagueId, weekNumber) {
  const { data, error } = await supabase
    .from('free_agents')
    .select(`
      *,
      players (
        id, name, position, team, sport, tier,
        tier_value, projected_points, is_injured
      )
    `)
    .eq('league_id', leagueId)
    .eq('week_number', weekNumber)
    .eq('is_available', true)
 
  if (error) throw error
  return data
}
 
// Pick up a free agent (costs 30 coins)
export async function pickupFreeAgent(freeAgentId, teamId, playerId, leagueId, slot) {
  // Mark FA as unavailable
  await supabase
    .from('free_agents')
    .update({ is_available: false })
    .eq('id', freeAgentId)
 
  // Add to roster
  await addToRoster(teamId, playerId, leagueId, slot)
 
  // Log transaction
  await logTransaction(leagueId, teamId, 'pickup', playerId, null, 30)
}
 
// ═══════════════════════════════════
// MATCHUP HELPERS
// ═══════════════════════════════════
 
// Get this week's matchups
export async function getMatchups(leagueId, weekNumber) {
  const { data, error } = await supabase
    .from('matchups')
    .select(`
      *,
      home: home_team_id ( id, team_name, wins, losses ),
      away: away_team_id ( id, team_name, wins, losses )
    `)
    .eq('league_id', leagueId)
    .eq('week_number', weekNumber)
 
  if (error) throw error
  return data
}
 
// Get my matchup this week
export async function getMyMatchup(leagueId, teamId, weekNumber) {
  const { data, error } = await supabase
    .from('matchups')
    .select(`
      *,
      home: home_team_id ( id, team_name, wins, losses, total_points ),
      away: away_team_id ( id, team_name, wins, losses, total_points )
    `)
    .eq('league_id', leagueId)
    .eq('week_number', weekNumber)
    .or(`home_team_id.eq.${teamId},away_team_id.eq.${teamId}`)
    .single()
 
  if (error) throw error
  return data
}
 
// ═══════════════════════════════════
// LEGENDARY HELPERS
// ═══════════════════════════════════
 
// Get this week's legendary player
export async function getLegendary(leagueId, weekNumber) {
  const { data, error } = await supabase
    .from('legendary_pool')
    .select(`
      *,
      players (
        id, name, position, team, sport,
        projected_points, headshot_url
      )
    `)
    .eq('league_id', leagueId)
    .eq('week_number', weekNumber)
    .single()
 
  if (error) throw error
  return data
}
 
// ═══════════════════════════════════
// TRANSACTION LOGGER
// ═══════════════════════════════════
 
export async function logTransaction(leagueId, teamId, type, playerId, relatedPlayerId, coinsSpent) {
  const { data: league } = await supabase
    .from('leagues')
    .select('week_number')
    .eq('id', leagueId)
    .single()
 
  const { error } = await supabase
    .from('transactions')
    .insert({
      league_id: leagueId,
      team_id: teamId,
      type,
      player_id: playerId,
      related_player_id: relatedPlayerId,
      coins_spent: coinsSpent,
      week_number: league.week_number
    })
 
  if (error) throw error
}

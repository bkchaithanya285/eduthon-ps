// Monolithic Node.js app serving API and frontend
require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const DatabaseManager = require('./json_store');
const MongoStore = require('./mongo_store');
const app = express();
const PORT = process.env.PORT || 3000;
let db;
let dbReadyPromise;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
// Configure trusted proxy safely (avoid permissive setting)
const TRUST_PROXY = process.env.VERCEL ? 1 : false;
app.set('trust proxy', TRUST_PROXY);

// Admin Login (cookie-based)
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
function isAuthenticated(req) {
  const cookie = req.headers['cookie'] || '';
  return cookie.split(';').some(c => c.trim().startsWith('admin_auth=1'));
}
function requireAdmin(req, res, next) {
  if (isAuthenticated(req)) return next();
  // If this is an API call, return JSON 401 instead of redirecting
  try {
    const url = String(req.originalUrl || req.url || '');
    if (url.startsWith('/api/')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  } catch (_) { }
  return res.redirect('/admin-login');
}

function formatProblems(statements) {
  return statements.map((ps) => {
    const technologies = Array.isArray(ps.technologies) ? ps.technologies : (ps.technologies ? ps.technologies : []);
    const selectedCount = Number.isFinite(ps.selected_count) ? ps.selected_count : (parseInt(ps.selected_count || '0', 10) || 0);
    const maxSelections = Math.max(1, (Number.isFinite(ps.max_selections) ? ps.max_selections : (parseInt(ps.max_selections || '0', 10) || 0)));
    const isAvailable = selectedCount < maxSelections;
    return {
      id: ps.id,
      title: ps.title,
      description: ps.description,
      category: ps.category || null,
      difficulty: ps.difficulty || null,
      technologies,
      selectedCount,
      maxSelections,
      isAvailable
    };
  });
}

// Ensure database is initialized before handling any requests on Vercel
if (process.env.VERCEL) {
  dbReadyPromise = (async () => { 
    try { 
      if (db) await initializeDatabase(); 
      else console.error('DB instance not created - check MONGODB_URI');
    } catch (e) { 
      console.error('DB init failed:', e); 
    } 
  })();
  app.use(async (req, res, next) => {
    try { if (dbReadyPromise) await dbReadyPromise; } catch (_) { }
    if (!db) return res.status(500).json({ error: 'Database connection not configured (check MONGODB_URI)' });
    next();
  });
}

// Add rate limiting (enabled in production only)
const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many requests from this IP, please try again later.',
  trustProxy: true
});
if (process.env.NODE_ENV === 'production') {
  app.use('/api/', limiter);
}

if (process.env.MONGODB_URI) {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'hackathon';
  const prefix = process.env.MONGODB_COLLECTION_PREFIX || '';
  db = new MongoStore(uri, dbName, prefix);
} else {
  console.error("CRITICAL: MONGODB_URI not found in .env.");
  // Don't exit on Vercel to allow the handler to provide error feedback
  if (!process.env.VERCEL) process.exit(1);
}

// Teams CSV (optional auto-fill)
const TEAMS_CSV_PATH = path.join(__dirname, 'teams.csv');
let teamNumberToTeam = new Map();
function loadTeamsCSV() {
  console.log('Attempting to load teams.csv from:', TEAMS_CSV_PATH);
  try {
    if (!fs.existsSync(TEAMS_CSV_PATH)) { 
      console.error('CRITICAL: teams.csv NOT FOUND at path:', TEAMS_CSV_PATH);
      teamNumberToTeam = new Map(); 
      return; 
    }
    const content = fs.readFileSync(TEAMS_CSV_PATH, 'utf8');
    console.log(`Read ${content.length} characters from teams.csv`);
    const lines = content.split(/\r?\n/).filter(Boolean);
    const [header, ...rows] = lines;
    const expected = 'teamNumber,password,teamName,teamLeader';
    if (!header || header.trim().toLowerCase() !== expected.toLowerCase()) { 
      // Fallback for missing password column if user keeps old format
      console.warn('CSV Header Mismatch. Expected:', expected);
    }
    const map = new Map();
    rows.forEach((line) => {
      const parts = line.split(',');
      if (parts.length < 3) return;
      const teamNumberRaw = String(parts[0]).trim();
      // Normalize team number to integer string to avoid padding issues (e.g. "007" -> "7")
      const teamNumber = String(parseInt(teamNumberRaw, 10));
      const password = parts[1] !== undefined ? String(parts[1]).trim() : '';
      const teamName = parts[2] !== undefined ? String(parts[2]).trim() : '';
      const teamLeader = parts[3] !== undefined ? String(parts[3]).trim() : 'Team Lead';
      if (isNaN(parseInt(teamNumber, 10))) return;
      map.set(teamNumber, { teamNumber, password, teamName, teamLeader });
    });
    teamNumberToTeam = map;
    console.log(`Successfully loaded ${map.size} teams. Sample Mapping: "7" -> "${map.get('7')?.teamName || 'N/A'}"`);
  } catch (err) { 
    console.error('Error loading CSV:', err);
    teamNumberToTeam = new Map(); 
  }
}
loadTeamsCSV();

// SSE for live updates
const connectedClients = new Set();
function broadcastUpdate(type, data) {
  const message = `data: ${JSON.stringify({ type, data, timestamp: new Date().toISOString() })}\n\n`;
  connectedClients.forEach((client) => { try { client.write(message); } catch (_) { connectedClients.delete(client); } });
}

// Global Problem Release Timer
let globalUnlockTime = null; // Storing as Unix timestamp ms
// We no longer strictly lock it boolean style, but let's keep the boolean logic for backwards compatibility, or just override it:
let problemSelectionUnlocked = false;

// Team Authentication & Single Device Enforcement
const TEAM_PASSWORD = process.env.TEAM_PASSWORD || 'welcome123';
// Maps teamNumber -> active session token
const teamSessions = new Map();

function generateToken() {
  return require('crypto').randomBytes(16).toString('hex');
}

app.post('/api/team/login', express.urlencoded({ extended: false }), async (req, res) => {
  const teamId = (req.body.teamId || '').trim().toUpperCase();
  const password = (req.body.password || '').trim();
  console.log(`Login attempt - TeamID: "${teamId}", Password: "${password}"`);

  // Validate Team ID Format (EDUTHON-001 to EDUTHON-026)
  const teamRegex = /^EDUTHON-0(?:0[1-9]|1[0-9]|2[0-6])$/;
  if (!teamRegex.test(teamId)) {
    return res.status(401).send('<!DOCTYPE html><html><body style="font-family:Arial;padding:20px"><h3 style="color:#c10016">Invalid Team ID</h3><p>Team ID must be between EDUTHON-001 and EDUTHON-026.</p><button onclick="window.history.back()">Back</button></body></html>');
  }

  const teamNumRaw = String(teamId.split('-')[1] || '').trim();
  const teamNum = String(parseInt(teamNumRaw, 10)); // e.g. "007" -> "7"
  
  // DB Primary Auth
  let teamData = null;
  try {
    if (db && typeof db.getTeam === 'function') {
      teamData = await db.getTeam(teamNum);
    }
  } catch (err) {
    console.warn('[DB-FAIL] Falling back to CSV for auth:', err);
  }

  // Fallback to CSV
  if (!teamData) {
    teamData = teamNumberToTeam.get(teamNum);
  }

  if (!teamData) {
    return res.status(401).send('<!DOCTYPE html><html><body style="font-family:Arial;padding:20px"><h3 style="color:#c10016">Unknown Identity</h3><p>Team record not found.</p><button onclick="window.history.back()">Back</button></body></html>');
  }

  if (password !== teamData.password) {
    return res.status(401).send('<!DOCTYPE html><html><body style="font-family:Arial;padding:20px"><h3 style="color:#c10016">Access denied</h3><p>Invalid password for this Team ID.</p><button onclick="window.history.back()">Back</button></body></html>');
  }

  const sessionToken = generateToken();
  if (db && typeof db.saveSession === 'function') {
    await db.saveSession(teamId, sessionToken).catch(err => console.error('Failed to persist session:', err));
  }
  
  // Set 24h hardened cookie
  res.setHeader('Set-Cookie', `team_auth=${teamId}:${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  return res.redirect('/problem');
});

app.post('/api/team/logout', async (req, res) => {
  const teamId = await getTeamAuth(req);
  if (teamId && db && typeof db.clearSession === 'function') {
    await db.clearSession(teamId);
  }
  res.setHeader('Set-Cookie', 'team_auth=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
  return res.redirect('/');
});

async function getTeamAuth(req) {
  const cookieHeader = req.headers['cookie'] || '';
  const match = cookieHeader.split(';').find(c => c.trim().startsWith('team_auth='));
  if (!match) return null;
  const val = match.split('=')[1] || '';
  const [teamId, token] = val.split(':');
  if (!teamId || !token) return null;

  // Verify against active session store (Persistent in MongoDB)
  if (db && typeof db.verifySession === 'function') {
    const isValid = await db.verifySession(teamId, token);
    if (!isValid) return null;
  } else {
    // Fallback to in-memory for local/legacy
    if (teamSessions.get(teamId) !== token) return null;
  }
  return teamId;
}

// Team Authentication Middleware for API/Pages
async function requireTeamAuth(req, res, next) {
  if (await getTeamAuth(req)) {
    return next();
  }
  return res.redirect('/team-login');
}

// Endpoint to check team profile and global lock status
app.get('/api/team/me', async (req, res) => {
  res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
  const teamId = await getTeamAuth(req);
  if (!teamId) return res.status(401).json({ error: 'Unauthorized' });

  // Calculate if unlocked based on timer
  let isUnlocked = problemSelectionUnlocked;
  if (globalUnlockTime !== null && Date.now() >= globalUnlockTime) {
    isUnlocked = true;
  }

  // Look up team name from CSV map with resilient normalization
  const teamNumRaw = String(teamId.split('-')[1] || '').trim();
  const teamNum = String(parseInt(teamNumRaw, 10)); // e.g. "007" -> "7"
  const teamData = teamNumberToTeam.get(teamNum);
  const teamName = teamData ? teamData.teamName : teamId;
  
  console.log(`[IDENTITY-SYNC] Req: ${teamId} -> Key: "${teamNum}" -> Found: ${!!teamData} -> Name: ${teamName}`);

  // Fetch registration status in the same call to avoid lag
  const myRegistration = await db.getRegistrationByTeam(teamId);

  res.json({
    teamId,
    teamName,
    selectionUnlocked: isUnlocked,
    unlockTime: globalUnlockTime,
    myRegistration: myRegistration ? {
      problemStatementId: myRegistration.problemStatementId,
      problemTitle: myRegistration.problem_title
    } : null
  });
});

// Endpoint to fetch current team's registration
app.get('/api/team/my-registration', requireTeamAuth, async (req, res) => {
  try {
    const teamId = await getTeamAuth(req);
    if (!teamId) return res.status(401).json({ error: 'Unauthorized' });

    // Optimized direct lookup
    const myReg = await db.getRegistrationByTeam(teamId);
    if (!myReg) return res.status(404).json({ error: 'Not registered' });

    res.json({
      teamNumber: myReg.team_number,
      teamName: myReg.team_name,
      teamLeader: myReg.team_leader,
      problemTitle: myReg.problem_title
    });
  } catch (e) {
    console.error('Error in my-registration:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// Endpoint for Admin to set the release timer
app.post('/api/admin/set-timer', requireAdmin, express.json(), (req, res) => {
  const { unlockTimeMs } = req.body;
  if (unlockTimeMs) {
    globalUnlockTime = parseInt(unlockTimeMs);
    problemSelectionUnlocked = false; // Relock until timer hits
  } else {
    // If no time provided, just unlock immediately (manual override)
    globalUnlockTime = null;
    problemSelectionUnlocked = true;
  }

  broadcastUpdate('lock_status', {
    selectionUnlocked: problemSelectionUnlocked,
    unlockTime: globalUnlockTime
  });

  res.json({ success: true, selectionUnlocked: problemSelectionUnlocked, unlockTime: globalUnlockTime });
});

// Deprecated: old toggle lock logic, keeping for fallback
app.post('/api/admin/toggle-lock', requireAdmin, (req, res) => {
  problemSelectionUnlocked = !problemSelectionUnlocked;
  if (!problemSelectionUnlocked) globalUnlockTime = null; // Clear timer if manually locked
  broadcastUpdate('lock_status', { selectionUnlocked: problemSelectionUnlocked, unlockTime: globalUnlockTime });
  res.json({ selectionUnlocked: problemSelectionUnlocked, unlockTime: globalUnlockTime });
});

async function initializeDatabase() {
  if (!db) return;
  try {
    await db.init();
    const DATA_FILE = path.join(__dirname, 'data.json');
    if (fs.existsSync(DATA_FILE)) {
      const jsonData = JSON.parse(fs.readFileSync(DATA_FILE));
      if (jsonData.problemStatements?.length > 0) {
        await db.importFromJSON(jsonData);
      }
    }
    // Sync Teams from CSV
    if (teamNumberToTeam && teamNumberToTeam.size > 0 && typeof db.importTeams === 'function') {
      await db.importTeams(Array.from(teamNumberToTeam.values()));
    }
  } catch (error) {
    console.error('CRITICAL: Database initialization failed:', error);
    // On serverless, we don't exit; we let the next request retry or fail with status
    if (!process.env.VERCEL) process.exit(1);
  }
}

// API
app.get('/api/problem-statements', async (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    let statements;
    try {
      statements = await db.getAllProblemStatements();
    } catch (dbErr) {
      console.warn('[DB-FAIL] Fetching problems from JSON fallback');
      const DATA_FILE = path.join(__dirname, 'data.json');
      if (fs.existsSync(DATA_FILE)) {
        const jsonData = JSON.parse(fs.readFileSync(DATA_FILE));
        statements = jsonData.problemStatements || [];
      } else {
        throw dbErr;
      }
    }
    const formatted = formatProblems(statements).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    res.json(formatted);
  } catch (error) {
    console.error('Error in /api/problem-statements:', error);
    res.status(500).json({ error: 'Missions currently unavailable' });
  }
});


app.get('/api/teams', (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    res.json(Array.from(teamNumberToTeam.values()));
  } catch (_) { res.status(500).json({ error: 'Failed to load teams' }); }
});

app.get('/api/teams/:teamNumber', (req, res) => {
  res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
  const team = teamNumberToTeam.get(String(req.params.teamNumber).trim());
  if (!team) return res.status(404).json({ error: 'Team not found' });
  res.json(team);
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Cache-Control' });
  res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Real-time updates enabled' })}\n\n`);
  connectedClients.add(res);
  const heartbeat = setInterval(() => { try { res.write(`data: ${JSON.stringify({ type: 'heartbeat', timestamp: new Date().toISOString() })}\n\n`); } catch (_) { clearInterval(heartbeat); connectedClients.delete(res); } }, 30000);
  req.on('close', () => { clearInterval(heartbeat); connectedClients.delete(res); });
});

app.post('/api/register', async (req, res) => {
  try {
    const isTimerUnlocked = globalUnlockTime !== null && Date.now() >= globalUnlockTime;
    if (!problemSelectionUnlocked && !isTimerUnlocked) {
      return res.status(403).json({ error: 'Selection Locked. Please wait for the mission clock to reach zero or for an Admin to initiate the launch.' });
    }

    // Authenticate the team and get their identity from the session
    const teamId = await getTeamAuth(req);
    if (!teamId) {
      return res.status(401).json({ error: 'Session expired or invalid. Please login again.' });
    }

    const { problemStatementId } = req.body;
    if (!problemStatementId) {
      return res.status(400).json({ error: 'Protocol Identifier missing.' });
    }

    const teamNumber = teamId;

    // Redundant early check for existing registration to save transaction overhead
    const existing = await db.getRegistrationByTeam(teamNumber);
    if (existing) {
      return res.status(409).json({ 
        error: 'Mission Already Secured', 
        details: 'You have already successfully claimed a mission protocol. Multiple selections are prohibited.' 
      });
    }

    // Fetch team details from CSV map or defaults
    const teamData = teamNumberToTeam.get(teamNumber);
    let teamName = teamData ? teamData.teamName : `Team ${teamNumber}`;
    let teamLeader = teamData ? teamData.teamLeader : 'Unknown';

    // ATOMIC REGISTRATION PATH (ULTRA-STREAMLINED)
    // We move all checks into the atomic transaction to save DB round-trips
    const registration = await db.createRegistrationAtomic({ 
      teamNumber, 
      teamName, 
      teamLeader, 
      problemStatementId 
    });

    if (!registration) {
      return res.status(409).json({
        error: 'Registration failed - Mission protocol might be full or already claimed',
        details: 'You may have already claimed a mission, or this mission reached its capacity. Syncing state...'
      });
    }

    // Success response is now minimal for speed
    const ps = { id: registration.problemStatementId }; // Minimal placeholder for immediate response


    // Broadcast updates asynchronously to avoid blocking the user's response
    setImmediate(async () => {
      try {
        const updatedRegistrations = await db.getAllRegistrations();
        const updatedProblems = formatProblems(await db.getAllProblemStatements());
        broadcastUpdate('registration', { 
          registrations: updatedRegistrations, 
          problems: updatedProblems, 
          newRegistration: { ...registration, problemStatement: ps } 
        });
      } catch (err) {
        console.error('Async broadcast error:', err);
      }
    });

    res.json({
      success: true,
      message: 'Registration successful!',
      registration: { ...registration, problemStatement: ps },
      problemStatement: {
        id: ps.id,
        title: ps.title,
        category: ps.category,
        difficulty: ps.difficulty,
        newStatus: 'Confirmed'
      }
    });
  } catch (error) {
    console.error('Error during registration:', error);
    res.status(500).json({ error: 'Registration failed', details: error.message });
  }
});

app.delete('/api/registration/:teamNumber', requireAdmin, async (req, res) => {
  try {
    const result = await db.deleteRegistration(req.params.teamNumber);
    if (result.changes === 0) return res.status(404).json({ error: 'Registration not found' });
    try {
      const updatedRegistrations = await db.getAllRegistrations();
      const updatedProblems = formatProblems(await db.getAllProblemStatements());
      broadcastUpdate('deletion', { registrations: updatedRegistrations, problems: updatedProblems, deletedTeamNumber: String(req.params.teamNumber).trim() });
    } catch (_) { }
    res.json({ message: 'Registration deleted successfully' });
  } catch (error) {
    console.error('Error deleting registration:', error);
    res.status(500).json({ error: 'Failed to delete registration' });
  }
});

// Admin: reset all data (re-seed defaults)
app.post('/api/reset', requireAdmin, async (req, res) => {
  try {
    await db.resetAll();
    const registrations = await db.getAllRegistrations();
    const problems = formatProblems(await db.getAllProblemStatements());
    broadcastUpdate('reset', { registrations, problems });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error during reset:', error);
    res.status(500).json({ error: 'Failed to reset data' });
  }
});

// Admin: replace problems with contents of data.json (keeps file as source of truth)
app.post('/api/admin/replace-with-data-file', requireAdmin, async (req, res) => {
  try {
    const DATA_FILE = path.join(__dirname, 'data.json');
    if (!fs.existsSync(DATA_FILE)) {
      return res.status(404).json({ error: 'data.json not found on server' });
    }
    const jsonData = JSON.parse(fs.readFileSync(DATA_FILE));
    // Clear current data then import
    await db.resetAll();
    await db.importFromJSON(jsonData);
    
    // Reset global lock state
    problemSelectionUnlocked = false;
    globalUnlockTime = null;
    
    const registrations = await db.getAllRegistrations();
    const problems = formatProblems(await db.getAllProblemStatements());
    
    broadcastUpdate('lock_status', { selectionUnlocked: false, unlockTime: null });
    broadcastUpdate('reset', { registrations, problems });
    res.json({ ok: true, importedProblems: problems.length });
  } catch (error) {
    console.error('Error replacing from data file:', error);
    res.status(500).json({ error: 'Failed to replace data from file' });
  }
});

app.get('/api/registrations', requireAdmin, async (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    const registrations = await db.getAllRegistrations();
    res.json(registrations);
  } catch (error) {
    console.error('Error fetching registrations:', error);
    res.status(500).json({ error: 'Failed to fetch registrations' });
  }
});

app.get('/api/evaluation-criteria', async (req, res) => {
  try {
    res.set({ 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' });
    let criteria = null;
    try {
      if (typeof db.getEvaluationCriteria === 'function') {
        criteria = await db.getEvaluationCriteria();
      }
    } catch (_) { }

    // Fallback to data.json if not found in DB
    if (!criteria) {
      try {
        const DATA_FILE = path.join(__dirname, 'data.json');
        if (fs.existsSync(DATA_FILE)) {
          const jsonData = JSON.parse(fs.readFileSync(DATA_FILE));
          if (jsonData && jsonData.evaluationCriteria) {
            criteria = jsonData.evaluationCriteria;
          }
        }
      } catch (_) { }
    }

    if (!criteria) {
      return res.status(404).json({ error: 'Evaluation criteria not found' });
    }
    res.json(criteria);
  } catch (error) {
    console.error('Error fetching evaluation criteria:', error);
    res.status(500).json({ error: 'Failed to fetch evaluation criteria' });
  }
});

// Export endpoints (CSV & HTML-to-print)
app.get('/api/export/registrations/csv', async (req, res) => {
  try {
    const registrations = await db.getAllRegistrations();
    let csv = 'Team Number,Team Name,Team Leader,Problem Title,Registration Date\n';
    registrations.forEach(r => {
      // Escape commas by quoting
      const tNum = `"${r.team_number}"`;
      const tName = `"${r.team_name.replace(/"/g, '""')}"`;
      const tLeader = `"${r.team_leader.replace(/"/g, '""')}"`;
      const pTitle = `"${(r.problem_title || '').replace(/"/g, '""')}"`;
      const date = `"${new Date(r.registration_date_time).toLocaleString('en-IN')}"`;
      csv += `${tNum},${tName},${tLeader},${pTitle},${date}\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="registrations-report.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Error exporting registrations CSV:', error);
    res.status(500).json({ error: 'Failed to export registrations CSV' });
  }
});

app.get('/api/export/problem-statements/csv', async (req, res) => {
  try {
    const problems = (await db.getAllProblemStatements()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    let csv = 'ID,Title,Category,Teams Selected,Max Capacity,Status\n';
    problems.forEach(p => {
      const id = `"${p.id}"`;
      const title = `"${p.title.replace(/"/g, '""')}"`;
      const cat = `"${(p.category || '').replace(/"/g, '""')}"`;
      const selected = p.selected_count ?? p.selectedCount;
      const max = p.max_selections ?? p.maxSelections;
      const status = (p.is_available ?? p.isAvailable) ? 'Available' : 'Full';
      csv += `${id},${title},${cat},${selected},${max},"${status}"\n`;
    });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="problem-statements-report.csv"');
    res.send(csv);
  } catch (error) {
    console.error('Error exporting problem statements CSV:', error);
    res.status(500).json({ error: 'Failed to export problem statements CSV' });
  }
});

app.get('/api/export/registrations/pdf', async (req, res) => {
  try {
    const registrations = await db.getAllRegistrations();
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Registrations</title><style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px}th{background:#c10016;color:#fff}</style></head><body><h1>Registrations</h1>${registrations.length ? `<table><thead><tr><th>Team #</th><th>Team Name</th><th>Leader</th><th>Problem</th><th>Date</th></tr></thead><tbody>${registrations.map(r => `<tr><td>${r.team_number}</td><td>${r.team_name}</td><td>${r.team_leader}</td><td>${r.problem_title}</td><td>${new Date(r.registration_date_time).toLocaleString('en-IN')}</td></tr>`).join('')}</tbody></table>` : `<p>No registrations.</p>`}</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="registrations-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting registrations PDF:', error);
    res.status(500).json({ error: 'Failed to export registrations PDF' });
  }
});

app.get('/api/export/problem-statements/pdf', async (req, res) => {
  try {
    const problems = (await db.getAllProblemStatements()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const html = `<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>Problem Statements</title><style>body{font-family:Arial;padding:20px}.card{border:1px solid #ddd;margin-bottom:10px;padding:10px;border-radius:4px}.status{font-weight:bold}.ok{color:#28a745}.full{color:#dc3545}</style></head><body><h1>Problem Statements</h1>${problems.map(p => { const teams = `${(p.selected_count ?? p.selectedCount)}/${(p.max_selections ?? p.maxSelections)}`; const isOk = (p.is_available ?? p.isAvailable); const statusHtml = `<span class=\"status ${isOk ? 'ok' : 'full'}\">${isOk ? 'Available' : 'Full'}</span>`; return `<div class=\"card\"><h3>${p.title}</h3><div>ID: ${p.id} | Category: ${p.category || 'N/A'} | Teams: ${teams} | Status: ${statusHtml}</div><div style=\"margin-top:6px;\">${p.description}</div></div>`; }).join('')}</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="problem-statements-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting problem statements PDF:', error);
    res.status(500).json({ error: 'Failed to export problem statements PDF' });
  }
});

app.get('/api/export/all/pdf', async (req, res) => {
  try {
    const problems = (await db.getAllProblemStatements()).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const registrations = await db.getAllRegistrations();
    const html = `<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>Complete Report</title><style>body{font-family:Arial;padding:20px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:8px}th{background:#c10016;color:#fff}.card{border:1px solid #ddd;margin-bottom:10px;padding:10px;border-radius:4px}.status{font-weight:bold}.ok{color:#28a745}.full{color:#dc3545}</style></head><body><h1>Complete Report</h1><h2>Problem Statements</h2>${problems.map(p => { const teams = `${(p.selected_count ?? p.selectedCount)}/${(p.max_selections ?? p.maxSelections)}`; const isOk = (p.is_available ?? p.isAvailable); const statusHtml = `<span class=\"status ${isOk ? 'ok' : 'full'}\">${isOk ? 'Available' : 'Full'}</span>`; return `<div class=\"card\"><strong>${p.title}</strong><div style=\"font-size:12px;color:#555;\">ID: ${p.id} | Category: ${p.category || 'N/A'} | Teams: ${teams} | Status: ${statusHtml}</div><div style=\"margin-top:6px;\">${p.description}</div></div>`; }).join('')}<h2>Registrations</h2>${registrations.length ? `<table><thead><tr><th>Team #</th><th>Team Name</th><th>Leader</th><th>Problem</th><th>Date</th></tr></thead><tbody>${registrations.map(r => `<tr><td>${r.team_number}</td><td>${r.team_name}</td><td>${r.team_leader}</td><td>${r.problem_title}</td><td>${new Date(r.registration_date_time).toLocaleDateString('en-IN')}</td></tr>`).join('')}</tbody></table>` : `<p>No registrations.</p>`}</body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Disposition', 'inline; filename="hackathon-complete-report.html"');
    res.send(html);
  } catch (error) {
    console.error('Error exporting complete PDF:', error);
    res.status(500).json({ error: 'Failed to export complete PDF' });
  }
});

// Frontend routes
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'home.html')); });
app.get('/team-login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'team-login.html')); });
app.get('/problem', requireTeamAuth, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'problem.html')); });
app.get('/admin', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.get('/admin-login', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'admin-login.html')); });
app.post('/api/admin/login', express.urlencoded({ extended: false }), (req, res) => {
  const user = (req.body.username || '').trim();
  const pass = (req.body.password || '').trim();
  // Debug logging to help diagnose login issues (do not expose in production)
  try {
    console.log('ADMIN LOGIN ATTEMPT', { receivedUser: user, receivedPassLength: pass.length, ADMIN_USER_set: !!ADMIN_USER, ADMIN_PASS_len: ADMIN_PASS ? ADMIN_PASS.length : 0 });
    try {
      if (!process.env.VERCEL) {
        const logLine = `${new Date().toISOString()} LOGIN_ATTEMPT user=${user} pass_len=${pass.length} ADMIN_USER_set=${!!ADMIN_USER} ADMIN_PASS_len=${ADMIN_PASS ? ADMIN_PASS.length : 0}\n`;
        fs.appendFileSync(path.join(__dirname, 'admin_debug.log'), logLine);
      }
    } catch (_) { }
  } catch (_) { }
  if (ADMIN_USER && ADMIN_PASS && user === ADMIN_USER && pass === ADMIN_PASS) {
    res.setHeader('Set-Cookie', 'admin_auth=1; Path=/; HttpOnly; SameSite=Lax');
    return res.redirect('/admin');
  }
  return res.status(401).send('<!DOCTYPE html><html><body style="font-family:Arial;padding:20px"><h3 style="color:#c10016">Access denied</h3><p>Admin credentials are not set or invalid. Please configure ADMIN_USER and ADMIN_PASS in environment variables.</p><a href="/admin-login">Back to login</a></body></html>');
});

// Admin auth status endpoint
app.get('/api/admin/status', (req, res) => {
  let isUnlocked = !!problemSelectionUnlocked;
  if (globalUnlockTime !== null && Date.now() >= globalUnlockTime) {
    isUnlocked = true;
  }
  res.json({
    authenticated: isAuthenticated(req),
    selectionUnlocked: isUnlocked,
    unlockTime: globalUnlockTime || null
  });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_auth=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax');
  return res.redirect('/admin-login');
});

process.on('SIGINT', async () => { await db.close(); process.exit(0); });

async function startServer() {
  await initializeDatabase();
  // Optional: auto-reset on cold start to ensure clean slate
  if (process.env.AUTO_RESET === '1') {
    try {
      await db.resetAll();
      const registrations = await db.getAllRegistrations();
      const problems = formatProblems(await db.getAllProblemStatements());
      broadcastUpdate('reset', { registrations, problems });
    } catch (e) {
      console.error('Auto reset failed:', e);
    }
  }
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('ADMIN_USER set:', !!process.env.ADMIN_USER, 'ADMIN_PASS set:', !!process.env.ADMIN_PASS);
  });
}

if (!process.env.VERCEL) {
  startServer().catch(console.error);
} else {
  // On Vercel, export the app for the serverless function runtime
  module.exports = app;
}



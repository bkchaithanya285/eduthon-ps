const { MongoClient } = require('mongodb');

class MongoStore {
  constructor(uri, dbName, collectionPrefix = '') {
    this.uri = uri;
    this.dbName = dbName;
    this.collectionPrefix = collectionPrefix || '';
    this.client = new MongoClient(this.uri, { serverSelectionTimeoutMS: 10000 });
    this.db = null;
    this.collections = null;
  }

  async init() {
    if (this.db) return;
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    const ps = this.db.collection(`${this.collectionPrefix}problem_statements`);
    const regs = this.db.collection(`${this.collectionPrefix}registrations`);
    const sessions = this.db.collection(`${this.collectionPrefix}sessions`);
    const teams = this.db.collection(`${this.collectionPrefix}teams`);
    this.collections = { ps, regs, sessions, teams };
    // indexes
    await ps.createIndex({ id: 1 }, { unique: true });
    await regs.createIndex({ teamNumber: 1 }, { unique: true });
    await regs.createIndex({ problemStatementId: 1 });
    await sessions.createIndex({ teamId: 1 }, { unique: true });
    await sessions.createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 }); // 24h expiry
    await teams.createIndex({ teamNumber: 1 }, { unique: true });
    // seed defaults if empty: REMOVED to ensure data.json is the sole source of truth
    const count = await ps.estimatedDocumentCount();
    if (count === 0) {
      console.log('Database empty. Waiting for JSON seed...');
    }
  }

  async close() {
    try { await this.client.close(); } catch (_) {}
  }

  _normalizeTeamId(rawId) {
    if (!rawId) return '';
    const s = String(rawId).trim();
    const teamNumRaw = s.includes('-') ? s.split('-')[1] : s;
    const parsed = parseInt(teamNumRaw, 10);
    return isNaN(parsed) ? s : String(parsed);
  }

  async getAllProblemStatements() {
    if (!this.collections) await this.init();
    const { ps, regs } = this.collections;
    const [problems, registrations] = await Promise.all([
      ps.find({}).toArray(),
      regs.find({}).toArray()
    ]);
    const idToCount = new Map();
    registrations.forEach(r => {
      idToCount.set(r.problemStatementId, (idToCount.get(r.problemStatementId) || 0) + 1);
    });
    return problems.map(p => {
      const maxSel = Math.max(1, p.maxSelections || 0);
      const selected = idToCount.get(p.id) || 0;
      return {
        id: p.id,
        title: p.title,
        description: p.description,
        max_selections: maxSel,
        category: p.category || null,
        difficulty: p.difficulty || null,
        technologies: Array.isArray(p.technologies) ? p.technologies : [],
        selected_count: selected,
        is_available: selected < maxSel
      };
    });
  }

  async getProblemStatementById(id) {
    if (!this.collections) await this.init();
    const { ps } = this.collections;
    return await ps.findOne({ id })
  }

  async createProblemStatement(problemStatement) {
    if (!this.collections) await this.init();
    const { ps } = this.collections;
    const maxSel = Math.max(1, problemStatement.maxSelections || 0);
    try {
      await ps.insertOne({
        id: problemStatement.id,
        title: problemStatement.title,
        description: problemStatement.description,
        maxSelections: maxSel,
        selectedCount: 0,
        category: problemStatement.category || null,
        difficulty: problemStatement.difficulty || null,
        technologies: Array.isArray(problemStatement.technologies) ? problemStatement.technologies : []
      });
      return { id: problemStatement.id, changes: 1 };
    } catch (e) {
      return { id: problemStatement.id, changes: 0 };
    }
  }

  async updateProblemStatement(id, updates) {
    if (!this.collections) await this.init();
    const { ps } = this.collections;
    const doc = {};
    if (updates.title !== undefined) doc.title = updates.title;
    if (updates.description !== undefined) doc.description = updates.description;
    if (updates.category !== undefined) doc.category = updates.category;
    if (updates.difficulty !== undefined) doc.difficulty = updates.difficulty;
    if (updates.technologies !== undefined) doc.technologies = Array.isArray(updates.technologies) ? updates.technologies : [];
    if (updates.max_selections !== undefined || updates.maxSelections !== undefined) {
      const val = updates.max_selections ?? updates.maxSelections;
      doc.maxSelections = Math.max(1, parseInt(val) || 0);
    }
    const res = await ps.updateOne({ id }, { $set: doc });
    return { id, changes: res.modifiedCount };
  }

  async deleteProblemStatement(id) {
    if (!this.collections) await this.init();
    const { ps, regs } = this.collections;
    const res = await ps.deleteOne({ id });
    await regs.deleteMany({ problemStatementId: id });
    return { id, changes: res.deletedCount };
  }

  async getEvaluationCriteria() {
    if (!this.collections) await this.init();
    const criteriaCollection = this.db.collection(`${this.collectionPrefix}evaluation_criteria`);
    return await criteriaCollection.findOne({});
  }

  async getAllRegistrations() {
    if (!this.collections) await this.init();
    const { regs, ps } = this.collections;
    const [registrations, problems] = await Promise.all([
      regs.find({}).toArray(),
      ps.find({}).toArray()
    ]);
    const idToPs = new Map(problems.map(p => [p.id, p]));
    return registrations.map(r => ({
      team_number: r.teamNumber,
      team_name: r.teamName,
      team_leader: r.teamLeader,
      problem_title: idToPs.get(r.problemStatementId)?.title || 'Unknown Mission',
      problem_category: idToPs.get(r.problemStatementId)?.category || null,
      problem_difficulty: idToPs.get(r.problemStatementId)?.difficulty || null,
      registration_date_time: r.registrationDateTime
    }));
  }

  async getRegistrationsByProblemStatement(problemStatementId) {
    if (!this.collections) await this.init();
    const { regs, ps } = this.collections;
    const problem = await ps.findOne({ id: problemStatementId });
    const list = await regs.find({ problemStatementId }).toArray();
    return list.map(r => ({
      team_number: r.teamNumber,
      team_name: r.teamName,
      team_leader: r.teamLeader,
      problem_title: problem?.title || '',
      registration_date_time: r.registrationDateTime
    }));
  }

  async getRegistrationByTeam(rawTeamId) {
    if (!this.collections) await this.init();
    const { regs, ps } = this.collections;
    const target = this._normalizeTeamId(rawTeamId);
    if (!target) return null;
    
    const r = await regs.findOne({ teamNumber: target });
    if (!r) return null;
    
    const problem = await ps.findOne({ id: r.problemStatementId });
    return {
      team_number: r.teamNumber,
      team_name: r.teamName,
      team_leader: r.teamLeader,
      problemStatementId: r.problemStatementId, 
      problem_title: problem?.title || 'Unknown Mission',
      problem_category: problem?.category || null,
      problem_difficulty: problem?.difficulty || null,
      registration_date_time: r.registrationDateTime
    };
  }

  async isTeamNumberTaken(teamNumber) {
    if (!this.collections) await this.init();
    const { regs } = this.collections;
    const target = this._normalizeTeamId(teamNumber);
    const found = await regs.findOne({ teamNumber: target });
    return Boolean(found);
  }

  async getTeam(teamNumber) {
    if (!this.collections) await this.init();
    const { teams } = this.collections;
    const target = this._normalizeTeamId(teamNumber);
    return await teams.findOne({ teamNumber: target });
  }

  async importTeams(teamsArray) {
    if (!Array.isArray(teamsArray)) return;
    if (!this.collections) await this.init();
    const { teams } = this.collections;
    for (const t of teamsArray) {
      const target = this._normalizeTeamId(t.teamNumber);
      await teams.updateOne(
        { teamNumber: target },
        { $set: { 
          teamNumber: target,
          password: t.password,
          teamName: t.teamName,
          teamLeader: t.teamLeader
        }},
        { upsert: true }
      );
    }
    console.log(`Synchronized ${teamsArray.length} teams to MongoDB.`);
  }

  async createRegistrationAtomic(registration) {
    if (!this.collections) await this.init();
    const { regs, ps } = this.collections;
    const target = this._normalizeTeamId(registration.teamNumber);
    
    const session = this.client.startSession();
    try {
      let result = null;
      await session.withTransaction(async () => {
        const exists = await regs.findOne({ teamNumber: target }, { session });
        if (exists) {
          result = null; return;
        }
        const capacity = await ps.updateOne(
          {
            id: registration.problemStatementId,
            $expr: { $lt: [ { $ifNull: ["$selectedCount", 0] }, { $ifNull: ["$maxSelections", 1] } ] }
          },
          { $inc: { selectedCount: 1 } },
          { session }
        );
        if (capacity.modifiedCount === 0) throw new Error('MISSION_FULL');
        
        const record = {
          teamNumber: target,
          teamName: registration.teamName,
          teamLeader: registration.teamLeader,
          problemStatementId: registration.problemStatementId,
          registrationDateTime: new Date().toISOString()
        };
        await regs.insertOne(record, { session });
        result = { teamNumber: record.teamNumber, problemStatementId: record.problemStatementId };
      }, {
        readConcern: { level: 'majority' },
        writeConcern: { w: 'majority' }
      });
      return result;
    } catch (error) {
      if (error.message === 'MISSION_FULL') return null;
      if (error.code === 11000) return null;
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async deleteRegistration(teamNumber) {
    if (!this.collections) await this.init();
    const { regs, ps } = this.collections;
    const target = this._normalizeTeamId(teamNumber);
    const reg = await regs.findOne({ teamNumber: target });
    const res = await regs.deleteOne({ teamNumber: target });
    if (res.deletedCount > 0 && reg && reg.problemStatementId) {
      await ps.updateOne({ id: reg.problemStatementId }, { $inc: { selectedCount: -1 } }).catch(() => {});
    }
    return { changes: res.deletedCount };
  }

  async importFromJSON(jsonData) {
    if (!jsonData || !Array.isArray(jsonData.problemStatements)) return;
    if (!this.collections) await this.init();
    const { ps } = this.collections;
    for (const psItem of jsonData.problemStatements) {
      const maxSel = Math.max(1, parseInt(psItem.maxSelections || psItem.max_selections) || 1);
      const doc = {
        id: psItem.id,
        title: psItem.title,
        description: psItem.description,
        maxSelections: maxSel,
        category: psItem.category || null,
        difficulty: psItem.difficulty || null,
        technologies: Array.isArray(psItem.technologies) ? psItem.technologies : []
      };
      await ps.updateOne({ id: psItem.id }, { $set: doc, $setOnInsert: { selectedCount: 0 } }, { upsert: true });
    }
    console.log(`Synchronized ${jsonData.problemStatements.length} missions.`);
  }

  async resetAll() {
    if (!this.collections) await this.init();
    const { ps, regs, sessions } = this.collections;
    await regs.deleteMany({});
    await ps.deleteMany({});
    await sessions.deleteMany({});
    return true;
  }

  async saveSession(teamId, token) {
    if (!this.collections) await this.init();
    const rawId = String(teamId).trim().toUpperCase();
    await this.collections.sessions.updateOne({ teamId: rawId }, { $set: { teamId: rawId, token, createdAt: new Date() } }, { upsert: true });
  }

  async verifySession(teamId, token) {
    if (!this.collections) await this.init();
    const rawId = String(teamId).trim().toUpperCase();
    const session = await this.collections.sessions.findOne({ teamId: rawId, token });
    return !!session;
  }

  async clearSession(teamId) {
    if (!this.collections) await this.init();
    const rawId = String(teamId).trim().toUpperCase();
    await this.collections.sessions.deleteOne({ teamId: rawId });
  }
}

module.exports = MongoStore;



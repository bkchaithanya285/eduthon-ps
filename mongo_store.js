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
      const parsedMax = typeof p.maxSelections === 'number' ? p.maxSelections : parseInt(p.maxSelections || '0', 10) || 0;
      const maxSel = Math.max(1, parsedMax);
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
    const parsedMax = typeof problemStatement.maxSelections === 'number' ? problemStatement.maxSelections : parseInt(problemStatement.maxSelections || '0', 10) || 0;
    const maxSel = Math.max(1, parsedMax);
    try {
      await ps.insertOne({
        id: problemStatement.id,
        title: problemStatement.title,
        description: problemStatement.description,
        maxSelections: maxSel,
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
      const parsed = typeof val === 'number' ? val : parseInt(val || '0', 10) || 0;
      doc.maxSelections = Math.max(1, parsed);
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
    // For MongoDB, we'll store evaluation criteria in a separate collection
    if (!this.collections) await this.init();
    const criteriaCollection = this.db.collection(`${this.collectionPrefix}evaluation_criteria`);
    const criteria = await criteriaCollection.findOne({});
    return criteria || null;
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
      problem_title: idToPs.get(r.problemStatementId)?.title || '',
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
    
    // Normalize to integer-string (canonical ID)
    const teamNumRaw = String(rawTeamId).includes('-') ? rawTeamId.split('-')[1] : rawTeamId;
    const target = String(parseInt(teamNumRaw, 10));
    
    const r = await regs.findOne({ teamNumber: target });
    if (!r) return null;
    
    const problem = await ps.findOne({ id: r.problemStatementId });
    return {
      team_number: r.teamNumber,
      team_name: r.teamName,
      team_leader: r.teamLeader,
      problemStatementId: r.problemStatementId, 
      problem_title: problem?.title || '',
      problem_category: problem?.category || null,
      problem_difficulty: problem?.difficulty || null,
      registration_date_time: r.registrationDateTime
    };
  }

  async isTeamNumberTaken(teamNumber) {
    if (!this.collections) await this.init();
    const { regs } = this.collections;
    // Canonical normalization
    const teamNumRaw = String(teamNumber).includes('-') ? teamNumber.split('-')[1] : teamNumber;
    const target = String(parseInt(teamNumRaw, 10));
    const found = await regs.findOne({ teamNumber: target });
    return Boolean(found);
  }

  async getTeam(teamNumber) {
    if (!this.collections) await this.init();
    const { teams } = this.collections;
    // Canonical normalization
    const teamNumRaw = String(teamNumber).includes('-') ? teamNumber.split('-')[1] : teamNumber;
    const target = String(parseInt(teamNumRaw, 10));
    return await teams.findOne({ teamNumber: target });
  }

  async importTeams(teamsArray) {
    if (!Array.isArray(teamsArray)) return;
    if (!this.collections) await this.init();
    const { teams } = this.collections;
    for (const t of teamsArray) {
      await teams.updateOne(
        { teamNumber: String(t.teamNumber).trim() },
        { $set: { 
          teamNumber: String(t.teamNumber).trim(),
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
    
    // Canonical normalization
    const teamNumRaw = String(registration.teamNumber).includes('-') ? registration.teamNumber.split('-')[1] : registration.teamNumber;
    const target = String(parseInt(teamNumRaw, 10));
    
    // Start a MongoDB session for transaction
    const session = this.client.startSession();
    
    try {
      let result = null;
      
      await session.withTransaction(async () => {
        // Check if team number is already taken (within transaction)
        const exists = await regs.findOne({ teamNumber: target }, { session });
        if (exists) {
          result = null;
          return;
        }
        // Atomically reserve a slot only if selectedCount < maxSelections
        const capacity = await ps.updateOne(
          {
            id: registration.problemStatementId,
            $expr: {
              $lt: [
                { $ifNull: ["$selectedCount", 0] },
                { $ifNull: ["$maxSelections", 1] }
              ]
            }
          },
          { $inc: { selectedCount: 1 } },
          { session }
        );

        if (capacity.modifiedCount === 0) {
          // No slot available or problem doesn't exist - abort transaction
          result = null;
          throw new Error('MISSION_FULL');
        }

        // Create registration after capacity is reserved
        const record = {
          teamNumber: target,
          teamName: registration.teamName,
          teamLeader: registration.teamLeader,
          problemStatementId: registration.problemStatementId,
          registrationDateTime: new Date().toISOString()
        };
        
        try {
          await regs.insertOne(record, { session });
          result = { id: record.teamNumber, changes: 1 };
        } catch (e) {
          // Rollback capacity reservation on failure
          try { await ps.updateOne({ id: registration.problemStatementId }, { $inc: { selectedCount: -1 } }, { session }); } catch (_) {}
          throw e;
        }
      }, {
        readConcern: { level: 'majority' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary'
      });
      
      return result;
      
    } catch (error) {
      if (error.message === 'MISSION_FULL') return null;
      // Handle duplicate key error specifically
      if (error.code === 11000) {
        // Duplicate key error - team number already exists
        return null;
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }

  async deleteRegistration(teamNumber) {
    if (!this.collections) await this.init();
    const { regs, ps } = this.collections;
    const target = String(teamNumber).trim();
    const reg = await regs.findOne({ teamNumber: target });
    const res = await regs.deleteOne({ teamNumber: target });
    if (res.deletedCount > 0 && reg && reg.problemStatementId) {
      try { await ps.updateOne({ id: reg.problemStatementId }, { $inc: { selectedCount: -1 } }); } catch (_) {}
    }
    return { changes: res.deletedCount };
  }

   async importFromJSON(jsonData) {
    if (!jsonData || !Array.isArray(jsonData.problemStatements)) return;
    if (!this.collections) await this.init();
    const { ps } = this.collections;
    
    for (const psItem of jsonData.problemStatements) {
      const parsedMax = typeof psItem.maxSelections === 'number' ? psItem.maxSelections : parseInt(psItem.maxSelections || '0', 10) || 1;
      const maxSel = Math.max(1, parsedMax);
      
      const doc = {
        id: psItem.id,
        title: psItem.title,
        description: psItem.description,
        maxSelections: maxSel,
        selectedCount: 0,
        category: psItem.category || null,
        difficulty: psItem.difficulty || null,
        technologies: Array.isArray(psItem.technologies) ? psItem.technologies : []
      };

      // Upsert to ensure we update existing problem definitions (like maxSelections)
      await ps.updateOne(
        { id: psItem.id },
        { $set: doc },
        { upsert: true }
      );
    }
    console.log(`Synchronized ${jsonData.problemStatements.length} problem statements from JSON.`);
  }

  async resetAll() {
    if (!this.collections) await this.init();
    const { ps, regs, sessions } = this.collections;
    await regs.deleteMany({});
    await ps.deleteMany({});
    await sessions.deleteMany({});
    await this.init();
    return true;
  }

  async saveSession(teamId, token) {
    if (!this.collections) await this.init();
    await this.collections.sessions.updateOne(
      { teamId },
      { $set: { teamId, token, createdAt: new Date() } },
      { upsert: true }
    );
  }

  async verifySession(teamId, token) {
    if (!this.collections) await this.init();
    const session = await this.collections.sessions.findOne({ teamId, token });
    return !!session;
  }

  async clearSession(teamId) {
    if (!this.collections) await this.init();
    await this.collections.sessions.deleteOne({ teamId });
  }
}

module.exports = MongoStore;



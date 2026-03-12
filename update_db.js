require('dotenv').config();
const path = require('path');
const fs = require('fs');
const MongoStore = require('./mongo_store');
const DatabaseManager = require('./json_store');

async function updateDB() {
  let db;
  if (process.env.MONGODB_URI) {
    db = new MongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB || 'hackathon', process.env.MONGODB_COLLECTION_PREFIX || '');
  } else {
    db = new DatabaseManager();
  }
  
  try {
    await db.init();
    console.log("Database initialized.");
    
    const dataPath = path.join(__dirname, 'data.json');
    const dataJson = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    if (db.collections && db.collections.ps) {
        // It's MongoStore
        await db.collections.ps.deleteMany({});
        console.log("Cleared old problem statements from MongoDB.");
        
        if (dataJson.problemStatements && dataJson.problemStatements.length > 0) {
            // Prepare documents with maxSelections logic from store
            const toInsert = dataJson.problemStatements.map(psItem => {
                const parsedMax = typeof psItem.maxSelections === 'number' ? psItem.maxSelections : parseInt(psItem.maxSelections || '0', 10) || 0;
                return {
                    id: psItem.id,
                    title: psItem.title,
                    description: psItem.description,
                    maxSelections: Math.max(1, parsedMax),
                    category: psItem.category || null,
                    difficulty: psItem.difficulty || null,
                    technologies: Array.isArray(psItem.technologies) ? psItem.technologies : []
                };
            });
            await db.collections.ps.insertMany(toInsert);
            console.log("Successfully inserted new problem statements into MongoDB.");
        }
    } else {
       // It's JsonStore
       // resetAll clears everything including registrations. We want to avoid that if possible
       if (db.data) {
           db.data.problemStatements = [];
           await db._saveData();
           await db.importFromJSON(dataJson);
           console.log("Successfully replaced problem statements in JSON store.");
       }
    }
  } catch (err) {
    console.error("Error updating database:", err);
  } finally {
    if (db && db.close) {
        await db.close();
    }
  }
}

updateDB();

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const MongoStore = require('./mongo_store');

async function resetDB() {
  let db;
  if (process.env.MONGODB_URI) {
    db = new MongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB || 'hackathon', process.env.MONGODB_COLLECTION_PREFIX || '');
  }
  
  try {
    if (db) {
        await db.init();
        console.log("Database initialized.");
        await db.resetAll();
        
        // After resetAll(), the problem statements are also deleted, so we should import from data.json again
        const dataPath = path.join(__dirname, 'data.json');
        const dataJson = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
        
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
            console.log("Successfully re-inserted problem statements into MongoDB.");
        }
        
        console.log("Successfully cleared previous registrations and relaunched the process in MongoDB.");
    }
  } catch (err) {
    console.error("Error updating database:", err);
  } finally {
    if (db && db.close) {
        await db.close();
    }
  }
}

resetDB();

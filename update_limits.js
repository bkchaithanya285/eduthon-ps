require('dotenv').config();
const path = require('path');
const fs = require('fs');
const MongoStore = require('./mongo_store');

async function updateDB() {
  let db;
  if (process.env.MONGODB_URI) {
    db = new MongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB || 'hackathon', process.env.MONGODB_COLLECTION_PREFIX || '');
  }
  
  try {
    const dataPath = path.join(__dirname, 'data.json');
    const dataJson = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    // Update in data.json
    if (dataJson.problemStatements) {
        dataJson.problemStatements.forEach(ps => {
            ps.maxSelections = 1;
        });
        fs.writeFileSync(dataPath, JSON.stringify(dataJson, null, 2), 'utf8');
        console.log("Updated limits to 1 in data.json.");
    }

    if (db) {
        await db.init();
        console.log("Database initialized.");
        
        if (db.collections && db.collections.ps) {
            // Update all problem statements in MongoDB
             await db.collections.ps.updateMany({}, { $set: { maxSelections: 1 } });
             console.log("Successfully updated limits to 1 in MongoDB.");
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

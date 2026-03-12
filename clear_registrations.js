require('dotenv').config();
const MongoStore = require('./mongo_store');

async function clearRegs() {
    const db = new MongoStore(process.env.MONGODB_URI, process.env.MONGODB_DB || 'hackathon');
    try {
        await db.init();
        console.log("Database connected.");
        
        // Clear registrations collection
        await db.collections.regs.deleteMany({});
        console.log("Cleared all registrations.");
        
        // Reset selectedCount for all missions to 0
        await db.collections.ps.updateMany({}, { $set: { selectedCount: 0 } });
        console.log("Reset all mission selection counts to 0.");
        
    } catch (e) {
        console.error("Reset failed:", e);
    } finally {
        await db.close();
        console.log("Relaunching system...");
    }
}

clearRegs();

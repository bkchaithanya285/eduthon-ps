require('dotenv').config();
const MongoStore = require('./mongo_store');

async function runStressTest() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB || 'hackathon';
  const prefix = process.env.MONGODB_COLLECTION_PREFIX || '';
  const db = new MongoStore(uri, dbName, prefix);
  await db.init();

  const testProblemId = 'ps001';
  console.log(`Starting Stress Test on Problem: ${testProblemId}`);

  // Reset the problem count
  const { ps, regs } = db.collections;
  await ps.updateOne({ id: testProblemId }, { $set: { selectedCount: 0, maxSelections: 1 } });
  await regs.deleteMany({ problemStatementId: testProblemId });

  console.log('Sending 10 concurrent registration requests...');

  const requests = [];
  for (let i = 1; i <= 10; i++) {
    const teamId = `STRESS-TEAM-${String(i).padStart(3, '0')}`;
    requests.push(db.createRegistrationAtomic({
      teamNumber: teamId,
      teamName: `Stress Team ${i}`,
      teamLeader: 'Bot',
      problemStatementId: testProblemId
    }));
  }

  const results = await Promise.all(requests);
  const successes = results.filter(r => r !== null);
  const failures = results.filter(r => r === null);

  console.log('\n--- Test Results ---');
  console.log(`Successful Registrations: ${successes.length}`);
  console.log(`Failed (Blocked) Registrations: ${failures.length}`);
  
  if (successes.length === 1) {
    console.log('\n✅ PASS: Only one team successfully claimed the mission.');
  } else {
    console.log(`\n❌ FAIL: ${successes.length} teams claimed the mission!`);
  }

  await db.close();
  process.exit(successes.length === 1 ? 0 : 1);
}

runStressTest().catch(console.error);

const fs = require('fs');
const path = require('path');

const rawText = fs.readFileSync(path.join(__dirname, 'raw_text.txt'), 'utf8');
const lines = rawText.split('\n');

const problemStatements = [];
let currentPs = null;

const psRegex = /^PS(\d+)\s*[-–]\s*(.+)$/i;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim();
  if (!line) continue;

  const match = line.match(psRegex);
  if (match) {
    if (currentPs) {
      currentPs.description = currentPs.description.trim();
      problemStatements.push(currentPs);
    }
    const numStr = match[1];
    const id = `ps${numStr.padStart(numStr.length < 3 ? 3 : numStr.length, '0')}`;
    const title = match[2].trim();
    currentPs = {
      id,
      title,
      description: "",
      maxSelections: 1,
      category: null,
      difficulty: null,
      technologies: []
    };
  } else if (currentPs) {
    currentPs.description += (currentPs.description ? "\n\n" : "") + line;
  }
}

if (currentPs) {
  currentPs.description = currentPs.description.trim();
  problemStatements.push(currentPs);
}

const dataPath = path.join(__dirname, 'data.json');
const dataJson = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Replace old problem statements
dataJson.problemStatements = problemStatements;

fs.writeFileSync(dataPath, JSON.stringify(dataJson, null, 2), 'utf8');

console.log(`Parsed and replaced ${problemStatements.length} problem statements in data.json`);

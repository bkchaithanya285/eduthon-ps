const mammoth = require("mammoth");
const fs = require("fs");
const path = require("path");

async function run() {
  const docxPath = path.join(__dirname, "problem_statements eduthon.docx");
  try {
    const result = await mammoth.extractRawText({ path: docxPath });
    fs.writeFileSync(path.join(__dirname, "raw_text.txt"), result.value, "utf8");
    console.log("Done");
  } catch (err) {
    console.error(err);
  }
}

run();

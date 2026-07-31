// filter_2517_2519.js
// Reads user_phone_list.txt and exports only numbers starting with 2517 or 2519 into a single file.

const fs = require('fs');
const path = require('path');

function filterPhones() {
  const inputFile = path.join(__dirname, 'user_phone_list.txt');
  const outputFile = path.join(__dirname, 'user_phone_list_2517_2519.txt');
  
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file not found at ${inputFile}`);
    process.exit(1);
  }

  console.log('Reading user_phone_list.txt...');
  const data = fs.readFileSync(inputFile, 'utf8');
  const lines = data.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  
  console.log(`Total source numbers: ${lines.length}`);
  
  // Filter for 2517 and 2519 prefixes only
  const filtered = lines.filter(phone => phone.startsWith('2517') || phone.startsWith('2519'));
  
  fs.writeFileSync(outputFile, filtered.join('\n'), 'utf8');
  
  console.log(`Filtered out ${lines.length - filtered.length} numbers.`);
  console.log(`Successfully saved ${filtered.length} numbers starting with 2517 or 2519 to: user_phone_list_2517_2519.txt`);
}

filterPhones();

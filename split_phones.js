// split_phones.js
// Reads user_phone_list.txt and splits it into files based on prefixes: 2519, 2517, 2510, and others.

const fs = require('fs');
const path = require('path');

function splitPhones() {
  const inputFile = path.join(__dirname, 'user_phone_list.txt');
  
  if (!fs.existsSync(inputFile)) {
    console.error(`Error: Input file not found at ${inputFile}`);
    process.exit(1);
  }

  console.log('Reading user_phone_list.txt...');
  const data = fs.readFileSync(inputFile, 'utf8');
  const lines = data.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  
  console.log(`Total phone numbers loaded: ${lines.length}`);
  
  const list2519 = [];
  const list2517 = [];
  const list2510 = [];
  const listOthers = [];
  
  for (const phone of lines) {
    if (phone.startsWith('2519')) {
      list2519.push(phone);
    } else if (phone.startsWith('2517')) {
      list2517.push(phone);
    } else if (phone.startsWith('2510')) {
      list2510.push(phone);
    } else {
      listOthers.push(phone);
    }
  }
  
  fs.writeFileSync(path.join(__dirname, 'user_phone_list_2519.txt'), list2519.join('\n'), 'utf8');
  fs.writeFileSync(path.join(__dirname, 'user_phone_list_2517.txt'), list2517.join('\n'), 'utf8');
  fs.writeFileSync(path.join(__dirname, 'user_phone_list_2510.txt'), list2510.join('\n'), 'utf8');
  fs.writeFileSync(path.join(__dirname, 'user_phone_list_others.txt'), listOthers.join('\n'), 'utf8');
  
  console.log('--- Split Summary ---');
  console.log(`- 2519 prefixed: ${list2519.length} saved to user_phone_list_2519.txt`);
  console.log(`- 2517 prefixed: ${list2517.length} saved to user_phone_list_2517.txt`);
  console.log(`- 2510 prefixed: ${list2510.length} saved to user_phone_list_2510.txt`);
  console.log(`- Others:        ${listOthers.length} saved to user_phone_list_others.txt`);
}

splitPhones();

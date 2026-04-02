const fs = require('fs');

let content = fs.readFileSync('src/socket/game.js', 'utf8');

// Replace betAmountCents assignment
content = content.replace(/const betAmountCents = Math\.round\(Number\(betAmount\) \* 100\);/g, 'const betAmountCents = Math.round(Number(betAmount));');

// Replace usages where it's divided by 100 for display or logic
content = content.replace(/betAmount: Number\(betAmountCents\) \/ 100,/g, 'betAmount: Number(betAmountCents),');
content = content.replace(/betAmount: betAmountCents \/ 100,/g, 'betAmount: betAmountCents,');
content = content.replace(/\$\{betAmountCents \/ 100\} ETB/g, '${betAmountCents} ETB');

// In calculatePrize / finishAndPayout
content = content.replace(/Number\(game\.bet_amount\) \/ 100/g, 'Number(game.bet_amount)');
content = content.replace(/const prizeBirr = Number\(prize\) \/ 100;/g, 'const prizeBirr = Number(prize);');

fs.writeFileSync('src/socket/game.js', content);
console.log('Fixed src/socket/game.js');

const {pool} = require('./src/db/index');
pool.query("SELECT id, username, number FROM users WHERE username ILIKE '%bini%' OR number = '251997666283'")
  .then(res => { 
    console.log("Found users:");
    console.log(res.rows); 
    pool.end(); 
  }).catch(e => { console.error(e); pool.end(); });

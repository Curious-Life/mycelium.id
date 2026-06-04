import D from 'better-sqlite3';
const db=new D(process.argv[2],{readonly:true});
console.log('users:', db.prepare('select email,emailVerified,name from user').all());
console.log('accounts:', db.prepare("select providerId,accountId from account").all());
db.close();

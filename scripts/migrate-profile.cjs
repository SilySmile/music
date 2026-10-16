const { migrateProfile, cleanupProfile } = require('../electron/profile.cjs');
const [operation, first, second] = process.argv.slice(2);
if (!first || !second || !['copy', 'cleanup'].includes(operation)) throw new Error('用法：node scripts/migrate-profile.cjs copy <旧目录> <新目录> | cleanup <迁移记录> <已确认旧目录>。操作前必须从托盘退出播放器。');
console.log(JSON.stringify(operation === 'copy' ? migrateProfile(first, second) : cleanupProfile(first, second), null, 2));

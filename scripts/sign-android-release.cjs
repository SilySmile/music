const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const policy = require('../build/android-signing.json');

function run(executable, args, environment = process.env) {
  const result = spawnSync(executable, args, { env: environment, windowsHide: true, encoding: null });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Android 签名工具失败：${path.basename(executable)}；请检查 JDK、SDK 及本机密钥配置。`);
  return result.stdout;
}
function main() {
  const root = path.resolve(__dirname, '..');
  const javaHome = process.env.JAVA_HOME;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!javaHome || !sdk) throw new Error('请配置 JAVA_HOME 和 ANDROID_HOME 后签名。');
  const java = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  const keytool = path.join(javaHome, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
  const versions = fs.readdirSync(path.join(sdk, 'build-tools')).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort((first, second) => first.localeCompare(second, 'en', { numeric: true }));
  const tools = path.join(sdk, 'build-tools', versions.at(-1) || 'missing');
  const apksigner = path.join(tools, 'lib', 'apksigner.jar');
  const version = require('../package.json').version;
  const unsigned = path.join(root, 'android/app/build/outputs/apk/release/app-release-unsigned.apk');
  fs.accessSync(unsigned);
  const directory = path.join(root, '.release-keys');
  fs.mkdirSync(directory, { recursive: true });
  const store = path.join(directory, 'android-release.p12');
  const secret = path.join(directory, 'android-keystore-password.txt');
  const certificate = (filename, alias, environment, passwordVariable) => {
    const bytes = run(keytool, ['-exportcert', '-keystore', filename, '-alias', alias, '-storepass:env', passwordVariable], environment);
    return crypto.createHash('sha256').update(bytes).digest('hex');
  };
  if (fs.existsSync(store) !== fs.existsSync(secret)) throw new Error('安卓签名库或口令缺失，请恢复备份，禁止生成替代签名身份。');
  if (!fs.existsSync(store)) {
    if (!process.argv.includes('--adopt-existing-key')) throw new Error('首次整理旧版签名需显式添加 --adopt-existing-key；不要为已有客户端随意生成新密钥。');
    const legacy = process.env.XIANQIJI_LEGACY_KEYSTORE || path.join(os.homedir(), '.android/debug.keystore');
    const password = crypto.randomBytes(36).toString('base64url');
    const environment = { ...process.env, XQ_LEGACY_STORE_PASSWORD: 'android', XQ_RELEASE_STORE_PASSWORD: password };
    if (certificate(legacy, 'androiddebugkey', environment, 'XQ_LEGACY_STORE_PASSWORD') !== policy.certificateSha256) throw new Error('旧签名证书与已发布 APK 不一致，未创建新签名库。');
    const temporary = path.join(directory, `android-${crypto.randomUUID()}.p12`);
    run(keytool, ['-importkeystore', '-srckeystore', legacy, '-srcstorepass:env', 'XQ_LEGACY_STORE_PASSWORD', '-srcalias', 'androiddebugkey', '-destkeystore', temporary, '-deststoretype', 'PKCS12', '-destalias', policy.alias, '-deststorepass:env', 'XQ_RELEASE_STORE_PASSWORD', '-destkeypass:env', 'XQ_RELEASE_STORE_PASSWORD', '-noprompt'], environment);
    if (certificate(temporary, policy.alias, environment, 'XQ_RELEASE_STORE_PASSWORD') !== policy.certificateSha256) throw new Error('签名身份迁入校验失败，请保留临时文件排查。');
    fs.writeFileSync(secret, `${password}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, store);
    console.log('原签名身份已保存到专用 PKCS12 库，使用随机强口令；未更换证书或修改旧调试库。');
  }
  const password = fs.readFileSync(secret, 'utf8').trim();
  if (!password) throw new Error('安卓签名口令为空，请恢复备份。');
  const environment = { ...process.env, XQ_RELEASE_STORE_PASSWORD: password };
  if (certificate(store, policy.alias, environment, 'XQ_RELEASE_STORE_PASSWORD') !== policy.certificateSha256) throw new Error('专用签名库证书不符，拒绝发布。');
  const outputDirectory = path.join(root, 'release', `v${version}`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const output = path.join(outputDirectory, `Xianqiji-${version}-android.apk`);
  run(java, ['-jar', apksigner, 'sign', '--ks', store, '--ks-key-alias', policy.alias, '--ks-pass', 'env:XQ_RELEASE_STORE_PASSWORD', '--key-pass', 'env:XQ_RELEASE_STORE_PASSWORD', '--v4-signing-enabled', 'false', '--out', output, unsigned], environment);
  const verified = run(java, ['-jar', apksigner, 'verify', '--verbose', '--print-certs', output]).toString('utf8');
  if (!verified.toLowerCase().includes(policy.certificateSha256)) throw new Error('最终 APK 签名证书不符，禁止发布。');
  console.log(`已签名并验证 Release APK：${output}`);
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }

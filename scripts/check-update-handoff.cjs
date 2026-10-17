const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

async function main() {
  if (process.platform !== 'win32') throw new Error('This regression requires Windows and NSIS.');
  const root = path.resolve(__dirname, '..');
  const nsis = process.env.ELECTRON_BUILDER_NSIS_DIR || path.join(root, '.tools/word-sync-builder/nsis-3.0.4.1');
  const compiler = path.join(nsis, 'Bin', 'makensis.exe');
  const directory = await fs.mkdtemp(path.join(root, 'test-results', 'update-handoff-'));
  const install = path.join(directory, '旧版程序 with spaces');
  const updates = path.join(install, 'Data', 'Updates');
  await fs.mkdir(updates, { recursive: true });
  const pollutedTemp = path.join(install, 'Data', 'Temp');
  await fs.mkdir(pollutedTemp, { recursive: true });
  const sentinel = path.join(install, 'Data', 'preserved.txt');
  await fs.writeFile(sentinel, 'original library/config fixture, must remain intact');
  const include = path.join(root, 'build', 'installer.nsh');
  const templates = path.join(root, 'node_modules/app-builder-lib/templates/nsis');
  const plugins = process.env.ELECTRON_BUILDER_NSIS_RESOURCES_DIR || path.join(root, '.tools/word-sync-builder/nsis-resources-3.4.1');
  const parseDestination = (await fs.readFile(path.join(templates, 'multiUser.nsh'), 'utf8')).match(/!macro GetDParameter outVar[\s\S]*?!macroend/)[0];
  const player = path.join(install, 'player-child.exe');
  const playerScript = path.join(directory, 'player.nsi');
  await fs.writeFile(playerScript, `\uFEFFUnicode true\nName "Exiting player fixture"\nOutFile "${player}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nFileOpen $0 "$EXEDIR\\child-ready.txt" w\nFileWrite $0 "ready"\nFileClose $0\nSleep 30000\nSectionEnd\n`);
  execFileSync(compiler, ['/V2', playerScript], { windowsHide: true, stdio: 'pipe' });
  for (const name of ['legacy', 'fixed-old-client', 'fixed-new-client']) {
    const fixed = name !== 'legacy';
    const output = path.join(updates, `${name}.exe`);
    const script = path.join(directory, `${name}.nsi`);
    // Reproduce the builder's broad install-directory process check. Fixtures
    // return an error instead of killing themselves; no installed app is used.
    const source = `Unicode true
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!addplugindir "${path.join(plugins, 'plugins/x86-unicode')}"
!include "${path.join(templates, 'include/StdUtils.nsh')}"
!include "${include}"
${parseDestination}
Var hasPerMachineInstallation
Var hasPerUserInstallation
Name "Update handoff fixture"
OutFile "${output}"
RequestExecutionLevel user
SilentInstall silent
Function .onInit
  ${fixed ? '!insertmacro preInit' : ''}
  !insertmacro GetDParameter $INSTDIR
  StrCpy $hasPerMachineInstallation 1
  StrCpy $hasPerUserInstallation 1
  ${fixed ? '!insertmacro customInit' : ''}
FunctionEnd
Section
  nsExec::ExecToStack \`"$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -C "if ((Get-CimInstance Win32_Process | Where-Object {$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')}).Count -gt 0) { exit 0 } else { exit 1 }"\`
  Pop $0
  Pop $1
  FileOpen $2 "$EXEDIR\\diagnostics.txt" w
  FileWrite $2 "$0|$INSTDIR|$CMDLINE|$1"
  FileClose $2
  FileOpen $2 "$INSTDIR\\temp-environment.txt" w
  FileWriteUTF16LE $2 "$TEMP|$PLUGINSDIR"
  FileClose $2
  \${If} $0 == 0
    SetErrorLevel 91
    Quit
  \${EndIf}
  FileOpen $0 "$INSTDIR\\handoff-success.txt" w
  FileWrite $0 "$EXEPATH"
  FileClose $0
SectionEnd
`;
    await fs.writeFile(script, '\uFEFF' + source, 'utf8');
    execFileSync(compiler, ['/V2', script], { windowsHide: true, stdio: 'pipe' });
    await fs.rm(path.join(install, 'child-ready.txt'), { force: true });
    await fs.rm(path.join(install, 'handoff-success.txt'), { force: true });
    const exitingPlayer = spawn(player, [], { windowsHide: true, stdio: 'ignore' });
    const playerClosed = new Promise((resolve) => exitingPlayer.once('exit', resolve));
    for (let attempt = 0; attempt < 60 && !await fs.stat(path.join(install, 'child-ready.txt')).catch(() => null); attempt++) await new Promise((resolve) => setTimeout(resolve, 50));
    let launchFile = output;
    const args = ['/currentuser'];
    if (name === 'fixed-new-client') {
      const stage = await fs.mkdtemp(path.join(directory, 'native-stage-'));
      launchFile = path.join(stage, 'setup.exe'); await fs.copyFile(output, launchFile);
      args.push('/XQ_STAGED');
    }
    args.push(`/D=${install}`);
    const temp = name === 'fixed-new-client' ? path.dirname(launchFile) : pollutedTemp;
    const child = spawn(launchFile, args, { cwd: path.dirname(launchFile), windowsHide: true, stdio: 'ignore', env: { ...process.env, TEMP: temp, TMP: temp }, ...(name === 'fixed-old-client' ? {} : { windowsVerbatimArguments: true, argv0: `"${launchFile}"` }) });
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    try { if (!fixed) {
      assert.equal(exit, 91, 'The old in-directory launch must reproduce the self-match.');
      assert.equal(await fs.stat(path.join(install, 'handoff-success.txt')).then(() => true, () => false), false);
    } else {
      assert.equal(exit, 0);
      let staged;
      for (let attempt = 0; attempt < 160; attempt++) {
        staged = await fs.readFile(path.join(install, 'handoff-success.txt'), 'utf8').catch(() => '');
        if (staged) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(staged, 'The relocated installer must finish after the original process exits.');
      assert.ok(!staged.toLowerCase().startsWith(install.toLowerCase()), staged);
      const temporaryPaths = (await fs.readFile(path.join(install, 'temp-environment.txt'), 'utf16le')).replace(/^\uFEFF/, '').split('|');
      for (const temporary of temporaryPaths) assert.ok(temporary && !temporary.toLowerCase().startsWith(install.toLowerCase()), temporary);
    }
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'original library/config fixture, must remain intact');
    assert.ok((await fs.stat(output)).size > 0, 'Original update remains available for retry.');
    } finally { if (exitingPlayer.exitCode === null) exitingPlayer.kill(); await playerClosed; }
  }
  console.log('PASS actual NSIS handoff: old Data/Updates launch reproduces self-match; new bootstrap escapes install tree, preserves Unicode/spaced /D destination and user-data sentinel, retains original package; isolated fixtures only');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

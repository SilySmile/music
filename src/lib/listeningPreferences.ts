export const cloudDownloadKey = 'xianqiji-auto-download-cloud';
export const cloudAutoDownload = () => localStorage.getItem(cloudDownloadKey) === 'true';
export function saveCloudAutoDownload(enabled: boolean) {
  localStorage.setItem(cloudDownloadKey, String(enabled));
  window.dispatchEvent(new Event('xianqiji-listening-preferences'));
}

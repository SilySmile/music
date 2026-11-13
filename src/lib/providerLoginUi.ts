import { Capacitor, registerPlugin } from '@capacitor/core';
import type { MusicProvider } from './providerSearch';

const native = registerPlugin<{ saveLoginQr(options: { image: string }): Promise<void>; openProviderApp(options: { provider: MusicProvider }): Promise<void> }>('MusicProviders');
export const mobileProviderLogin = () => Capacitor.getPlatform() === 'android';
export async function saveProviderQr(image: string) { await native.saveLoginQr({ image }); }
export async function openProviderApp(provider: MusicProvider) { await native.openProviderApp({ provider }); }
export async function shareProviderQr(image: string) {
  const [{ Directory, Filesystem }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')]);
  if (!/^data:image\/png;base64,[a-zA-Z0-9+/=]+$/.test(image) || image.length > 1000000) throw Error('登录二维码无效，请刷新后重试。');
  // A fixed cache file avoids retaining a new login image on each share.
  const file = await Filesystem.writeFile({ path: 'provider-login.png', directory: Directory.Cache, data: image.split(',')[1] });
  await Share.share({ title: '音乐账号登录二维码', dialogTitle: '将二维码发送到另一台设备后扫码', files: [file.uri] });
}

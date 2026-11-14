import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { isNative } from './platform';

/** Light tap feedback for button presses. No-op on the web; never throws. */
export async function hapticTap(): Promise<void> {
  if (!isNative()) return;
  try {
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Haptics are best-effort (e.g. disabled by the user or unsupported hardware).
  }
}

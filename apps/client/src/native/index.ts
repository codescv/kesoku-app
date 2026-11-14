export { getPlatform, isNative, type Platform } from './platform';
export { secureStore, type SecureStore } from './secureStore';
export { speak, stop as stopSpeaking, isTtsAvailable, type SpeakOptions, type SpeakResult } from './tts';
export { onDeepLink, parseDeepLink, type DeepLink, type DeepLinkModeId } from './deeplinks';
export { pickImages, type PickImagesOptions } from './camera';
export { hapticTap } from './haptics';

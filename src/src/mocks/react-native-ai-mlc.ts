/**
 * @react-native-ai/mlc — Expo Go mock
 * Offline AI Expo Go'da çalışmaz, cloud runtime kullanılır.
 */
export const mlc = {
  languageModel: (_modelId: string) => {
    throw new Error('[Mock] MLC offline AI Expo Go\'da desteklenmiyor. Cloud runtime kullanın.');
  },
};
export default { mlc };

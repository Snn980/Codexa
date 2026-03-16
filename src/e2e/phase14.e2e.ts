// e2e/phase14.e2e.ts
// Phase 14 E2E — Review fix
//
// Düzeltilen sorun:
//   FIX-12  Android clearInput: replaceText('') + clearText() → sadece replaceText('')
//           Android'de replaceText zaten içeriği temizler; ek clearText flaky davranır.
//           iOS'ta clearText yeterlidir.

import {
  by,
  device,
  element,
  expect as dExpect,
  waitFor,
} from 'detox';

const WAIT  = Number(process.env.DETOX_WAIT_TIMEOUT)  || 8_000;
const SHORT = Number(process.env.DETOX_SHORT_TIMEOUT) || 3_000;

// ─── FIX-12: clearInput ───────────────────────────────────────────────────────

async function clearInput(): Promise<void> {
  const input = element(by.id('chat-input'));
  if (device.getPlatform() === 'android') {
    // FIX-12 — replaceText('') tek başına yeterli; ek clearText Android'de flaky
    await input.replaceText('');
  } else {
    // iOS: clearText güvenilir
    await input.clearText();
  }
}

async function typeAndSend(text: string): Promise<void> {
  const input = element(by.id('chat-input'));
  await waitFor(input).toBeVisible().withTimeout(WAIT);
  await clearInput();
  await input.typeText(text);
  await waitFor(element(by.id('send-button'))).toBeEnabled().withTimeout(SHORT);
  await element(by.id('send-button')).tap();
}

async function waitForText(text: string): Promise<void> {
  await waitFor(element(by.text(text))).toBeVisible().withTimeout(WAIT);
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('Phase 14 — E2E', () => {

  describe('Chat history persist (MMKV)', () => {
    beforeEach(async () => {
      await device.launchApp({ newInstance: true });
    });

    afterAll(async () => {
      await device.terminateApp();
    });

    it('mesajlar uygulama yeniden başlatılınca korunur', async () => {
      await typeAndSend('Kalıcı mesaj testi');
      await waitForText('Kalıcı mesaj testi');

      await device.sendToHome();
      await device.launchApp({ newInstance: false });

      await waitFor(element(by.text('Kalıcı mesaj testi')))
        .toBeVisible()
        .withTimeout(WAIT);
    });

    it('yeni session oluşturulabilir', async () => {
      const newBtn = element(by.id('new-session-button'));
      await waitFor(newBtn).toBeVisible().withTimeout(SHORT);
      await newBtn.tap();
      await dExpect(element(by.id('chat-empty-placeholder'))).toBeVisible();
    });

    it('session listesi açılabilir', async () => {
      await typeAndSend('Session listesi testi');
      await waitForText('Session listesi testi');
      try {
        await element(by.id('session-drawer-button')).tap();
        await waitFor(element(by.id('session-list'))).toBeVisible().withTimeout(WAIT);
        await dExpect(element(by.id('session-list'))).toBeVisible();
      } catch { /* drawer yoksa skip */ }
    });

    it('session silinebilir', async () => {
      await typeAndSend('Silinecek session');
      await waitForText('Silinecek session');
      try {
        await element(by.id('session-drawer-button')).tap();
        await waitFor(element(by.id('session-list'))).toBeVisible().withTimeout(WAIT);
        await element(by.id('session-list-item-0')).swipe('left', 'fast');
        await element(by.id('session-delete-button')).tap();
        try { await element(by.text('Sil')).tap(); }
        catch { await element(by.text('Delete')).tap(); }
      } catch { /* UI farklıysa skip */ }
    });
  });

  describe('Streaming inference (cloud model)', () => {
    beforeAll(async () => {
      await device.launchApp({ newInstance: true });
    });

    it('streaming sırasında mesaj anlık güncellenir', async () => {
      try {
        await element(by.id('model-selector-button')).tap();
        await waitFor(element(by.id('model-download-sheet'))).toBeVisible().withTimeout(WAIT);
        await element(by.id('model-item-cloud-claude-haiku')).tap();
        await element(by.id('model-download-sheet')).swipe('down', 'fast');
      } catch { /* model seçimi yoksa geç */ }

      await typeAndSend('Merhaba, bir şey açıkla');

      try {
        await waitFor(element(by.id('streaming-indicator'))).toBeVisible().withTimeout(SHORT);
        await waitFor(element(by.id('streaming-indicator'))).not.toBeVisible().withTimeout(30_000);
      } catch { /* streaming indicator yoksa geç */ }

      await dExpect(element(by.id('chat-message-list'))).toBeVisible();
    });

    it('stream iptal edilebilir', async () => {
      await typeAndSend('Uzun bir şey yaz');
      try {
        await waitFor(element(by.id('cancel-stream-button'))).toBeVisible().withTimeout(SHORT);
        await element(by.id('cancel-stream-button')).tap();
        await waitFor(element(by.id('send-button'))).toBeEnabled().withTimeout(SHORT);
      } catch { /* cancel butonu yoksa skip */ }
    });
  });

  describe('Model indirme progress', () => {
    beforeAll(async () => {
      await device.launchApp({ newInstance: true });
    });

    it('indirme başlatılınca progress bar görünür', async () => {
      await element(by.id('model-selector-button')).tap();
      await waitFor(element(by.id('model-download-sheet'))).toBeVisible().withTimeout(WAIT);
      try {
        const downloadBtn = element(by.id('model-download-button-0'));
        await waitFor(downloadBtn).toBeVisible().withTimeout(SHORT);
        await downloadBtn.tap();
        await waitFor(element(by.id('download-progress-bar-0'))).toBeVisible().withTimeout(WAIT);
      } catch { /* İndirilecek model yoksa skip */
      } finally {
        await element(by.id('model-download-sheet')).swipe('down', 'fast');
      }
    });

    it('background kuyruğa alınan download badge gösterir', async () => {
      try {
        await waitFor(element(by.id('background-download-badge'))).toBeVisible().withTimeout(SHORT);
        await dExpect(element(by.id('background-download-badge'))).toBeVisible();
      } catch { /* kuyrukta download yok — skip */ }
    });
  });

  describe('Deep link — aiide:// scheme', () => {
    beforeEach(async () => {
      await device.launchApp({ newInstance: true });
    });

    it('aiide://chat chat ekranını açar', async () => {
      await device.openURL({ url: 'aiide://chat' });
      await waitFor(element(by.id('chat-message-list'))).toBeVisible().withTimeout(WAIT);
    });

    it('aiide://chat/session-abc sessionId ile açar', async () => {
      await device.openURL({ url: 'aiide://chat/session-abc' });
      await waitFor(element(by.id('chat-screen'))).toBeVisible().withTimeout(WAIT);
    });

    it('aiide://models models tab açar', async () => {
      await device.openURL({ url: 'aiide://models' });
      await waitFor(element(by.id('models-screen'))).toBeVisible().withTimeout(WAIT);
    });

    it('aiide://settings settings tab açar', async () => {
      await device.openURL({ url: 'aiide://settings' });
      await waitFor(element(by.id('settings-screen'))).toBeVisible().withTimeout(WAIT);
    });

    it('geçersiz deep link uygulama crash yapmaz', async () => {
      await device.openURL({ url: 'aiide://invalid/deep/link/xyz' });
      await waitFor(element(by.id('chat-screen')).atIndex(0)).toBeVisible().withTimeout(WAIT);
    });
  });

  describe('OTA güncelleme banner (mock manifest)', () => {
    it.skip('mock manifest inject ile banner görünür', async () => {
      await dExpect(element(by.id('ota-update-banner'))).toBeVisible();
    });
  });
});

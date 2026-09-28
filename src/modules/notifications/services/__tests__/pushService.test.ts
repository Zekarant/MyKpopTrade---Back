import { isAllowedPushEndpoint } from '../pushService';

describe('isAllowedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
    'https://web.push.apple.com/abc'
  ])('accepte le service de push d\'un navigateur : %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'https://localhost/push',
    'https://10.0.0.5/push',
    'http://fcm.googleapis.com/fcm/send/abc',
    'https://fcm.googleapis.com.evil.example/x',
    'https://evilfcm.googleapis.com.attacker.io/x',
    'pas une url',
    42
  ])('refuse un endpoint arbitraire ou interne : %s', (endpoint) => {
    expect(isAllowedPushEndpoint(endpoint)).toBe(false);
  });
});

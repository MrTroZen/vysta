import { describe, expect, it } from 'vitest';
import { actionLabel, AUTOMATIC_ACTIONS, isAutomaticActionName } from '../src/shared/actions';

describe('automatic action model', () => {
  it('keeps reserved names stable and maps them to owner language', () => {
    expect(AUTOMATIC_ACTIONS).toEqual({
      phone: '__vysta_phone_intent',
      whatsapp: '__vysta_whatsapp_intent',
      email: '__vysta_email_intent',
      form: '__vysta_form_intent',
    });
    expect(Object.values(AUTOMATIC_ACTIONS).map(actionLabel)).toEqual([
      'Phone clicks',
      'WhatsApp clicks',
      'Email clicks',
      'Form submissions',
    ]);
  });

  it('leaves configured action names unchanged', () => {
    expect(actionLabel('booking_confirmed')).toBe('booking_confirmed');
    expect(isAutomaticActionName('booking_confirmed')).toBe(false);
    expect(isAutomaticActionName(AUTOMATIC_ACTIONS.form)).toBe(true);
  });
});

export const AUTOMATIC_ACTIONS = {
  phone: '__vysta_phone_intent',
  whatsapp: '__vysta_whatsapp_intent',
  email: '__vysta_email_intent',
  form: '__vysta_form_intent',
} as const;

export type AutomaticActionName = (typeof AUTOMATIC_ACTIONS)[keyof typeof AUTOMATIC_ACTIONS];

const LABELS: Record<AutomaticActionName, string> = {
  [AUTOMATIC_ACTIONS.phone]: 'Phone clicks',
  [AUTOMATIC_ACTIONS.whatsapp]: 'WhatsApp clicks',
  [AUTOMATIC_ACTIONS.email]: 'Email clicks',
  [AUTOMATIC_ACTIONS.form]: 'Form submissions',
};

export function isAutomaticActionName(name: string): name is AutomaticActionName {
  return Object.prototype.hasOwnProperty.call(LABELS, name);
}

export function actionLabel(name: string | null | undefined): string {
  if (!name) return 'Untitled action';
  return isAutomaticActionName(name) ? LABELS[name] : name;
}

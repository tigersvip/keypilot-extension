import type { FillProfile } from './types';

// Previous releases automatically hid these ordinary profile fields.
const ordinaryKeys = new Set([
  'dob', 'dobMonth', 'dobDay', 'dobYear', 'ssn', 'ssnLast4', 'itin', 'idNumber',
  'passportNumber', 'passportCountry', 'passportExpiry', 'driverLicenseNumber',
  'driverLicenseExpiry', 'vin', 'policyNumber', 'ein', 'dunsNumber',
  'businessLicenseNumber', 'bankName', 'bankAccountHolder', 'bankAccountType'
]);

export function migrateFillProfilePrivacy(profile: FillProfile): FillProfile {
  if (profile.privacyVersion === 1) return profile;
  return {
    ...profile,
    privacyVersion: 1,
    fields: profile.fields.map(field => ordinaryKeys.has(field.key)
      ? { ...field, sensitivity: 'normal' }
      : field)
  };
}

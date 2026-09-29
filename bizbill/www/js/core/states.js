// GST state codes (India). Used for Place of Supply and intra/inter-state
// tax split. The list is data only; the business user remains responsible
// for choosing the correct state.
export const STATES = [
  ['01', 'Jammu and Kashmir'],
  ['02', 'Himachal Pradesh'],
  ['03', 'Punjab'],
  ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'],
  ['06', 'Haryana'],
  ['07', 'Delhi'],
  ['08', 'Rajasthan'],
  ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'],
  ['11', 'Sikkim'],
  ['12', 'Arunachal Pradesh'],
  ['13', 'Nagaland'],
  ['14', 'Manipur'],
  ['15', 'Mizoram'],
  ['16', 'Tripura'],
  ['17', 'Meghalaya'],
  ['18', 'Assam'],
  ['19', 'West Bengal'],
  ['20', 'Jharkhand'],
  ['21', 'Odisha'],
  ['22', 'Chhattisgarh'],
  ['23', 'Madhya Pradesh'],
  ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'],
  ['27', 'Maharashtra'],
  ['29', 'Karnataka'],
  ['30', 'Goa'],
  ['31', 'Lakshadweep'],
  ['32', 'Kerala'],
  ['33', 'Tamil Nadu'],
  ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'],
  ['36', 'Telangana'],
  ['37', 'Andhra Pradesh'],
  ['38', 'Ladakh'],
  ['97', 'Other Territory'],
  ['96', 'Other Country'],
];

const byCode = new Map(STATES.map(([c, n]) => [c, n]));
const byName = new Map(STATES.map(([c, n]) => [n.toLowerCase(), c]));
// Legacy codes that may appear in older GSTINs / records.
byCode.set('25', 'Daman and Diu');
byCode.set('28', 'Andhra Pradesh (Old)');

export function stateName(code) {
  return byCode.get(String(code || '').padStart(2, '0')) || '';
}

export function stateCodeFromName(name) {
  return byName.get(String(name || '').trim().toLowerCase()) || '';
}

export function isKnownStateCode(code) {
  return byCode.has(String(code || ''));
}

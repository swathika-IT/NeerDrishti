import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateSms, buildPreview, validateContact, maskContact, severityFromRisk } from '../src/services/notifications/preview';

test('SMS GSM-7: 160 chars = 1 segment, 161 = 2 segments of 153', () => {
  assert.deepEqual([estimateSms('a'.repeat(160)).segments, estimateSms('a'.repeat(160)).encoding], [1, 'GSM-7']);
  const e = estimateSms('a'.repeat(161)); assert.equal(e.segments, 2); assert.equal(e.per_segment_limit, 153);
  assert.equal(estimateSms('a'.repeat(306)).segments, 2); assert.equal(estimateSms('a'.repeat(307)).segments, 3);
});

test('SMS GSM-7 extension characters (€ { }) cost two units', () => {
  assert.equal(estimateSms('€'.repeat(80)).units, 160); assert.equal(estimateSms('€'.repeat(80)).segments, 1);
  assert.equal(estimateSms('€'.repeat(81)).segments, 2);
});

test('SMS Unicode: Telugu / Hindi / emoji force UCS-2 with 70 / 67 limits', () => {
  const te = estimateSms('వరద ప్రమాదం'); assert.equal(te.encoding, 'UCS-2'); assert.equal(te.single_limit, 70);
  assert.equal(estimateSms('अ'.repeat(70)).segments, 1); assert.equal(estimateSms('अ'.repeat(71)).segments, 2);
  assert.equal(estimateSms('अ'.repeat(134)).segments, 2); assert.equal(estimateSms('अ'.repeat(135)).segments, 3);
  assert.equal(estimateSms('a😀').encoding, 'UCS-2'); assert.equal(estimateSms('a😀').units, 3);   // emoji = 2 UTF-16 units
  assert.equal(estimateSms('').segments, 0);
});

test('WhatsApp preview has a character count and NO SMS segment data; SMS has segments; email has subject', () => {
  const base = { districtName: 'Nirmal', severity: 'HIGH' as const, language: 'en' as const };
  const wa = buildPreview({ ...base, channel: 'WHATSAPP' }); assert.equal(wa.metrics.sms, undefined); assert.ok(wa.metrics.characters > 20);
  assert.doesNotMatch(JSON.stringify(wa), /segment/i);
  const sms = buildPreview({ ...base, channel: 'SMS' }); assert.ok(sms.metrics.sms && sms.metrics.sms.segments >= 1);
  const em = buildPreview({ ...base, channel: 'EMAIL' }); assert.match(em.subject!, /Nirmal/); assert.equal(em.metrics.sms, undefined);
});

test('every severity x language x channel renders, names the district, says demo/112 and never claims delivery or an official order', () => {
  for (const sev of ['NORMAL', 'WATCH', 'ELEVATED', 'HIGH', 'CRITICAL'] as const)
    for (const language of ['en', 'te', 'hi'] as const)
      for (const channel of ['WHATSAPP', 'SMS', 'EMAIL'] as const) {
        const p = buildPreview({ districtName: 'Nirmal', severity: sev, language, channel });
        assert.ok(p.body.includes('Nirmal')); assert.ok(p.body.includes('112'));
        assert.doesNotMatch(p.body, /evacuat|delivered|ordered/i);
      }
  assert.equal(buildPreview({ districtName: 'X', severity: 'HIGH', language: 'te', channel: 'SMS' }).metrics.sms!.encoding, 'UCS-2');
});

test('contact validation and masking', () => {
  assert.equal(validateContact('SMS', '').ok, true);
  assert.deepEqual(validateContact('SMS', '+91 98765-43210'), { ok: true, value: '+919876543210' });
  assert.equal(validateContact('WHATSAPP', '9876543210').ok, false);
  assert.equal(validateContact('EMAIL', 'a@b').ok, false); assert.equal(validateContact('EMAIL', 'demo@example.com').ok, true);
  assert.equal(maskContact('SMS', '+919876543210'), '+91*******210'); assert.equal(maskContact('EMAIL', 'demo@example.com'), 'd***@example.com');
});

test('actual risk category maps to a preview severity', () => {
  assert.deepEqual(['LOW', 'MODERATE', 'HIGH', 'CRITICAL'].map(c => severityFromRisk(c as any)), ['NORMAL', 'WATCH', 'HIGH', 'CRITICAL']);
});

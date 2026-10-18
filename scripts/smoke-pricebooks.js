'use strict';
// Smoke test for price books: NHIS default, illustrative samples, clinic default, platform default, CSV upload, enable/disable.
//   node scripts/smoke-pricebooks.js
process.env.CREDENTIAL_ENCRYPTION_KEY = process.env.CREDENTIAL_ENCRYPTION_KEY || 'smoke-test-only-key-do-not-use-in-production';
const store = require('../src/store');
const pb = require('../src/services/priceBooks');
let a = 0;
const ok = (cond, label) => { a++; if (!cond) { console.error(`FAIL #${a}: ${label}`); process.exitCode = 1; } else console.log(`ok  : ${label}`); };
const rej = (p) => p.then(() => null, (e) => e);

(async () => {
  await store.init?.();
  const T = 'tenant-a'; const U = 'tenant-b';
  let s = await pb.summary(T);
  ok(s.defaultId === 'nhis-gh' && s.books.length >= 12, 'NHIS is the default and many books are offered');
  ok(s.books.find((b) => b.id === 'nhs-uk').currency === 'GBP' && !s.books.find((b) => b.id === 'nhs-uk').official, 'NHS UK is offered in pounds and marked illustrative');
  ok(['private-gh-standard', 'private-uk', 'us-medicare'].every((id) => s.books.some((b) => b.id === id)), 'private-insurer and US books are present');
  const nhis = await pb.get(T, 'nhis-gh'); ok(pb.search(nhis, 'paracetamol', { limit: 5 }).length > 0 && nhis.currency === 'GHS', 'NHIS searches by name');
  const uk = await pb.get(T, 'nhs-uk'); const hit = pb.search(uk, 'caesar')[0]; ok(hit && hit.price > 0, 'NHS sample book searches and has prices');

  await pb.setTenantDefault(T, { bookId: 'nhs-uk' });
  ok((await pb.resolveDefaultId(T)) === 'nhs-uk' && (await pb.resolveDefaultId(U)) === 'nhis-gh', 'a clinic default applies to that clinic only');
  ok((await rej(pb.setTenantDefault(T, { bookId: 'nope' }))).status === 404, 'unknown book is refused');
  s = await pb.setTenantDefault(T, { followCurrency: false }); ok(s.followCurrency === false && s.defaultId === 'nhs-uk', 'follow-currency choice is saved without changing the default');

  await pb.adminSet({ defaultId: 'private-gh-standard' });
  ok((await pb.resolveDefaultId(U)) === 'private-gh-standard' && (await pb.resolveDefaultId(T)) === 'nhs-uk', 'platform default covers clinics that have not chosen');
  await pb.adminSet({ disabled: ['us-medicare'] });
  ok(!(await pb.summary(U)).books.some((b) => b.id === 'us-medicare'), 'a switched-off book disappears for clinics');
  ok((await rej(pb.adminSet({ defaultId: 'us-medicare' }))).status === 422, 'cannot default a switched-off book');
  await pb.adminSet({ disabled: [] });

  const csv = 'Code;Item;Price\nX1;Scan;1,5\nX2;Visit;20\nX2;Dup;3\n;;\nX3;Bad;abc\n';
  const up = await pb.upload(T, { name: 'My tariff', currency: 'ngn', csv: 'code,name,price\nX1,"Scan, large",1500.50\nX2,Visit,2000\nX2,Dup,3\nX3,Bad,abc' });
  ok(up.imported === 2 && up.skippedCount === 2 && up.book.currency === 'NGN', 'CSV upload imports good rows and reports skipped ones');
  const semi = pb.itemsFromCsv(csv); ok(semi.items.length === 2 && semi.items[0].price === 1.5, 'semicolon files with decimal commas are understood');
  const own = await pb.get(T, up.book.id); ok(own && pb.search(own, 'scan')[0].price === 1500.5, 'quoted commas survive and the uploaded book is searchable');
  ok(!(await pb.summary(U)).books.some((b) => b.id === up.book.id), 'a clinic upload is private to that clinic');
  ok((await rej(pb.upload(T, { name: 'x', currency: 'GHS', csv: 'foo,bar\n1,2' }))).status === 422, 'a file without name and price columns is refused');
  await pb.setTenantDefault(T, { bookId: up.book.id }); await pb.remove(T, up.book.id);
  ok((await pb.resolveDefaultId(T)) !== up.book.id, 'deleting a default book falls back');
  const plat = await pb.upload('platform', { name: 'Group tariff', currency: 'USD', csv: 'name,price\nA,1' });
  ok((await pb.summary(U)).books.some((b) => b.id === plat.book.id), 'a platform upload is offered to every clinic');
  console.log(`\nPRICE BOOKS CHECK: ${a} assertions ${process.exitCode ? 'WITH FAILURES' : 'passed'}`);
})().catch((e) => { console.error(e); process.exit(1); });

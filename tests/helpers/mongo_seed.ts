import { MongoClient } from 'mongodb';
import { assertSafeMongoTestUri, assertSafeTestDbName } from './mongo_test_harness';

export async function seedBaseDistricts(db: any) {
  const districts = ['hyderabad','warangal','khammam','nirmal','karimnagar','nizamabad','adilabad','jangaon','suryapet','narayanpet','wanaparthy','vikarabad','yadadri_bhuvanagiri','siddipet','kamareddy','mahabubnagar','jogulamba_gadwal','peddapalli','bhadradri_kothagudem','mulugu']
    .map((id,i)=>({ _id: id, district_id: id, district_name: id.split('_').map(s=>s[0].toUpperCase()+s.slice(1)).join(' '), monitoring_category:'Standard', region_zone:'Central Telangana', data_source_mode:'Simulated Data', data_confidence:'Medium' }));
  await db.collection('districts').deleteMany({});
  await db.collection('districts').insertMany(districts);
}

export async function seedUser(db: any, doc: any) {
  const id = doc._id || (await nextSeq(db,'users'));
  await db.collection('users').insertOne({ ...doc, _id: id, created_at: doc.created_at || new Date().toISOString(), updated_at: doc.updated_at || new Date().toISOString() });
  return id;
}

export async function nextSeq(db: any, name: string) {
  const r = await db.collection('sequences').findOneAndUpdate({ name }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' });
  return Number(r?.value || 1);
}
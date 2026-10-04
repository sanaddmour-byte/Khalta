// A SYNTHETIC optimizer world for the Studio specs: two plants with the engine's synthetic materials and the
// synthetic engineering parameters written into the rules (labelled test data, never real values).
import { expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import { OPT_MATERIALS, SYNTHETIC_PARAMS } from '../packages/engine/src/testing/optimizer';
import { emailFor, PASSWORD } from './support';

const BASE = 'http://localhost:5173';
async function as(role: string): Promise<APIRequestContext> {
  const ctx = await pwRequest.newContext({ baseURL: BASE });
  const res = await ctx.post('/api/auth/sign-in/email', {
    data: { email: emailFor(role), password: PASSWORD },
  });
  expect(res.ok(), `sign in as ${role}`).toBe(true);
  return ctx;
}

let done: Promise<{ plantA: string; plantB: string }> | null = null;
export const STUDIO_PLANTS = { a: 'STU-01', b: 'STU-02' };

export function seedStudioWorld() {
  return (done ??= (async () => {
    const admin = await as('admin');
    const qc = await as('qc_manager');
    // another spec file (own worker) may have seeded the world already: seed once per database
    const existing = (await (await admin.get('/api/plants')).json()) as {
      id: string;
      code: string;
    }[];
    const ea = existing.find((x) => x.code === STUDIO_PLANTS.a);
    const eb = existing.find((x) => x.code === STUDIO_PLANTS.b);
    if (ea && eb) return { plantA: ea.id, plantB: eb.id };
    // engineering parameters (kinds: parameter / range): written as new, unverified rule versions
    const rules = (await (await admin.get('/api/rules?ruleset=ENGINEERING')).json()).rules as {
      id: string;
      key: string;
      value?: unknown;
    }[];
    const aci = (await (await admin.get('/api/rules?ruleset=ACI')).json()).rules as {
      id: string;
      key: string;
      value?: unknown;
    }[];
    for (const [key, value] of Object.entries(SYNTHETIC_PARAMS)) {
      const hit = [...rules, ...aci].find((r) => r.key === key);
      expect(hit, `rule ${key}`).toBeDefined();
      // another worker may have written it already (the specs seed this world concurrently)
      if (JSON.stringify(hit!.value) === JSON.stringify(value)) continue;
      // rule values are engineering values: the QC manager writes them, never the admin
      const res = await qc.patch(`/api/rules/${hit!.id}/value`, {
        data: { value, reason: 'SYNTHETIC test parameter' },
      });
      expect(res.ok(), `patch ${key}: ${await res.text()}`).toBe(true);
    }
    const plants: string[] = [];
    for (const code of [STUDIO_PLANTS.a, STUDIO_PLANTS.b]) {
      const list = (await (await admin.get('/api/plants')).json()) as {
        id: string;
        code: string;
      }[];
      let p = list.find((x) => x.code === code);
      if (!p) {
        const res = await admin.post('/api/plants', {
          data: { code, nameEn: `Studio ${code}`, nameAr: `استوديو ${code}` },
        });
        expect(res.ok(), await res.text()).toBe(true);
        p = (await res.json()) as { id: string; code: string };
      }
      plants.push(p.id);
    }
    const sup = await qc.post('/api/suppliers', {
      data: { nameEn: 'Studio supplier', nameAr: 'مورد الاستوديو' },
    });
    expect(sup.ok(), await sup.text()).toBe(true);
    const supplierId = ((await sup.json()) as { id: string }).id;
    for (const [pi, plantId] of plants.entries()) {
      const entries: {
        materialId: string;
        plantId: string;
        supplierId: string;
        price: string;
        unit: string;
      }[] = [];
      for (const m of OPT_MATERIALS) {
        const created = await qc.post('/api/materials', {
          data: {
            category: m.category,
            plantId,
            marketNameEn: pi === 0 ? m.id : `${m.id} B`,
            marketNameAr: pi === 0 ? `${m.id} ع` : `${m.id} ب`,
          },
        });
        expect(created.ok(), await created.text()).toBe(true);
        const id = ((await created.json()) as { id: string }).id;
        const t = await qc.post(`/api/materials/${id}/tests`, {
          data: {
            properties: m.test!.properties,
            source: 'supplier_datasheet',
            testedAt: new Date().toISOString().slice(0, 10),
          },
        });
        expect(t.ok(), await t.text()).toBe(true);
        const p = m.price as { price: string; unit: string };
        entries.push({ materialId: id, plantId, supplierId, price: p.price, unit: p.unit });
      }
      const pr = await admin.post('/api/prices', {
        data: { entries, reason: 'SYNTHETIC test prices' },
      });
      expect(pr.ok(), await pr.text()).toBe(true);
    }
    return { plantA: plants[0]!, plantB: plants[1]! };
  })());
}

let profilesDone: Promise<void> | null = null;
export const SYN_PROFILES = {
  family: 'SYNTHETIC C30 family',
  tenant: 'SYNTHETIC company defaults',
};

/** Two SYNTHETIC profiles (test data only): drafted by a QC engineer, approved by the QC manager. */
export function seedProfiles() {
  return (profilesDone ??= (async () => {
    await seedStudioWorld();
    const eng = await as('qc_engineer');
    const mgr = await as('qc_manager');
    const make = async (data: Record<string, unknown>) => {
      const res = await eng.post('/api/profiles', { data });
      expect(res.ok(), await res.text()).toBe(true);
      const { id } = (await res.json()) as { id: string };
      const ap = await mgr.post(`/api/profiles/${id}/versions/1/approve`, { data: {} });
      expect(ap.ok(), await ap.text()).toBe(true);
    };
    await make({
      scope: 'product_family',
      family: 'C30',
      nameEn: SYN_PROFILES.family,
      nameAr: 'خلطة C30 اصطناعية',
      appliesTo: { fcMin: 25, fcMax: 35 },
      characteristics: { sand_ratio_pct: { mode: 'range', min: 38, max: 46 } },
      materials: {},
      objective: null,
      mode: null,
    });
    await make({
      scope: 'tenant',
      nameEn: SYN_PROFILES.tenant,
      nameAr: 'افتراضيات محطة اصطناعية',
      appliesTo: {},
      characteristics: {},
      materials: {},
      objective: 'cheapest',
      mode: null,
    });
  })());
}

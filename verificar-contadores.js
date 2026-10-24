#!/usr/bin/env node
/**
 * verificar-contadores.js
 *
 * Confere os documentos da coleção `counters` (os contadores de ID) no
 * Firestore REAL do projeto e aponta o que está errado:
 *
 *   AUSENTE      — o app procura counters/<nome> e esse documento não existe
 *                  (erro mais comum: o documento foi criado com "ID automático" ou
 *                  com o ID digitado com maiúscula/espaço);
 *   TIPO         — o campo `value` está como TEXTO ("5"). No Console do Firebase o
 *                  padrão é texto, e as regras do Firestore só aceitam número;
 *   ATRASADO     — o contador está MENOR que o maior ID já usado na coleção
 *                  correspondente (o próximo ID repetiria um que já existe);
 *   SOBRANDO     — documentos em `counters` que o app não usa (ex.: ID automático).
 *
 * SEGURO POR PADRÃO:
 *   node verificar-contadores.js              -> só mostra o relatório
 *   node verificar-contadores.js --criar      -> cria os AUSENTES
 *   node verificar-contadores.js --corrigir   -> converte texto em número e levanta os ATRASADOS
 *   (pode combinar: --criar --corrigir)
 *
 * Ao criar, o valor inicial é o MAIOR ID que já existe na coleção (ou 0 se estiver
 * vazia) — assim o primeiro ID novo nunca repete um existente. Valores nunca são
 * diminuídos e nenhum documento é apagado.
 *
 * Primeira vez:
 *   npm install firebase-admin
 *   salve a chave de conta de serviço como ./serviceAccountKey.json (NUNCA envie esse arquivo)
 */

const fs = require('fs');
const path = require('path');

/** contador -> [coleção, campo do ID] (o maior ID da coleção é o piso do contador) */
const COUNTERS = {
  next_transaction_id: ['transactions', 'transaction_id'],
  next_group_id: ['transactions', 'transaction_group_id'],
  next_category_id: ['categories', 'category_id'],
  next_pay_method_id: ['payMethods', 'pay_method_id'],
  next_reserve_id: ['reserves', 'reserve_id'],
  next_reserve_movement_id: ['reserveMovements', 'movement_id'],
  next_charge_id: ['charges', 'charge_id'],
  next_charge_payment_id: ['chargePayments', 'charge_payment_id'],
  next_fixed_charge_id: ['fixedCharges', 'fixed_charge_id'],
  next_stage_id: ['stages', 'stage_id'],
  next_task_id: ['tasks', 'task_id'],
  next_material_id: ['materials', 'material_id'],
  next_tool_id: ['tools', 'tool_id'],
  next_video_id: ['videos', 'video_id'],
  next_article_id: ['articles', 'article_id'],
  next_shop_item_id: ['shopItems', 'item_id'],
  next_shop_list_id: ['shopLists', 'list_id'],
  next_shop_list_item_id: ['shopListItems', 'list_item_id'],
  next_shop_purchase_id: ['shopPurchases', 'purchase_id'],
  next_shop_purchase_item_id: ['shopPurchaseItems', 'purchase_item_id'],
  next_shop_file_id: ['shopFiles', 'file_id'],
  next_shop_recipe_id: ['shopRecipes', 'recipe_id'],
  next_gift_person_id: ['giftPeople', 'person_id'],
  next_gift_item_id: ['giftItems', 'gift_item_id']
};

const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Função pura (testável sem Firebase).
 *   existing: { [idDoDocumento]: dadosDoDocumento }  (coleção counters)
 *   maxIds:   { [nomeDoContador]: maiorIdNumericoDaColecao }
 * Devolve um item por contador exigido + a lista de documentos sobrando.
 */
function analyze(existing, maxIds) {
  const items = Object.keys(COUNTERS).map((name) => {
    const max = Number(maxIds[name]) || 0;
    const doc = existing[name];
    const item = { name, collection: COUNTERS[name][0], max, status: [], value: null };
    if (!doc) {
      item.status.push('AUSENTE');
      const similar = Object.keys(existing).find((id) => norm(id) === norm(name));
      if (similar) item.similar = similar;
      item.createWith = max;
      return item;
    }
    const raw = doc.value;
    item.value = raw;
    if (typeof raw !== 'number') {
      item.status.push('TIPO');
      item.fixTo = Math.max(Number(raw) || 0, max);
    }
    const numeric = Number(raw) || 0;
    if (numeric < max) {
      item.status.push('ATRASADO');
      item.fixTo = Math.max(item.fixTo || 0, max);
    }
    if (!item.status.length) item.status.push('OK');
    return item;
  });
  const extras = Object.keys(existing).filter((id) => !COUNTERS[id]);
  return { items, extras };
}

function printReport(report, log) {
  log('\n=== CONTADORES ===');
  report.items.forEach((it) => {
    const flags = it.status.join(' + ');
    let detail = '';
    if (it.status.includes('AUSENTE')) detail = it.similar ? ` (existe "${it.similar}" — o ID precisa ser exatamente "${it.name}")` : ` (seria criado com value = ${it.createWith})`;
    else if (it.status[0] !== 'OK') detail = ` (value atual: ${JSON.stringify(it.value)}${it.fixTo !== undefined ? ` -> ${it.fixTo}` : ''}; maior ID em ${it.collection}: ${it.max})`;
    else detail = ` (value = ${it.value}; maior ID em ${it.collection}: ${it.max})`;
    log(`  ${it.status[0] === 'OK' ? 'OK      ' : flags.padEnd(8)} ${it.name}${detail}`);
  });
  if (report.extras.length) {
    log('\nDocumentos em counters que o app NÃO usa (podem ser criados com "ID automático" por engano):');
    report.extras.forEach((id) => log(`  SOBRANDO ${id}`));
  }
  const bad = report.items.filter((i) => i.status[0] !== 'OK').length;
  log(`\n${bad ? bad + ' contador(es) precisam de atenção.' : 'Todos os contadores estão corretos.'}`);
  return bad;
}

async function run({ db, create, fix, log = console.log }) {
  const snap = await db.collection('counters').get();
  const existing = {};
  snap.forEach((d) => { existing[d.id] = d.data(); });

  const maxIds = {};
  const byCollection = {};
  for (const [name, [collection, field]] of Object.entries(COUNTERS)) {
    byCollection[collection] = byCollection[collection] || (await db.collection(collection).get());
    let max = 0;
    byCollection[collection].forEach((d) => {
      const v = Number(d.data()[field]);
      if (isFinite(v) && v > max) max = v;
    });
    maxIds[name] = max;
  }

  const report = analyze(existing, maxIds);
  const bad = printReport(report, log);
  if (!bad) return { bad: 0, created: 0, fixed: 0 };

  let created = 0;
  let fixed = 0;
  if (!create && !fix) {
    log('\nSIMULAÇÃO — nada foi alterado. Use --criar (cria os AUSENTES) e/ou --corrigir (texto -> número e ATRASADOS).');
    return { bad, created, fixed };
  }
  for (const it of report.items) {
    if (create && it.status.includes('AUSENTE')) {
      await db.collection('counters').doc(it.name).set({ value: it.createWith });
      log(`  criado   ${it.name} = ${it.createWith}`);
      created++;
    } else if (fix && (it.status.includes('TIPO') || it.status.includes('ATRASADO'))) {
      await db.collection('counters').doc(it.name).update({ value: it.fixTo });
      log(`  corrigido ${it.name}: ${JSON.stringify(it.value)} -> ${it.fixTo}`);
      fixed++;
    }
  }
  log(`\nCriados: ${created} | Corrigidos: ${fixed}. Rode de novo para conferir.`);
  return { bad, created, fixed };
}

async function main() {
  const args = process.argv.slice(2);
  const { initializeApp, cert } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(__dirname, 'serviceAccountKey.json');
  if (!fs.existsSync(keyPath)) {
    console.error(`Chave não encontrada em: ${keyPath}\nSalve a chave como serviceAccountKey.json ao lado do script.`);
    process.exit(1);
  }
  const key = require(keyPath);
  initializeApp({ credential: cert(key) });
  console.log(`Projeto: ${key.project_id}`);
  await run({ db: getFirestore(), create: args.includes('--criar'), fix: args.includes('--corrigir') });
}

module.exports = { analyze, run, COUNTERS };

if (require.main === module) {
  main().catch((e) => { console.error('Erro:', e.message); process.exit(1); });
}

#!/usr/bin/env node
/* Empacota a extensao. Gera TRES artefatos, e cada um existe por um motivo:
 *
 *   dist/impressora-enviagora-<v>.zip           auto-hospedado — com "key" e "update_url".
 *                                               E o que o operador baixa para "carregar
 *                                               sem compactacao", e a base do CRX.
 *   dist/impressora-enviagora-<v>.crx           assinado. Instalacao com auto-update.
 *   dist/impressora-enviagora-<v>-webstore.zip  SEM "key" e SEM "update_url" — a Web Store
 *                                               recusa manifest com update_url. E o plano B.
 *
 * O "key" e o que trava o ID. ID travado e o que faz o toggle de "Permitir acesso a URLs
 * de arquivo" sobreviver as atualizacoes e a migracao de unpacked para CRX. Sem ele, cada
 * instalacao vira uma extensao diferente e o problema volta.
 *
 * Sem a chave privada (CRX_PRIVATE_KEY ou ./chave-privada.pem) o script ainda gera os
 * ZIPs, usando a chave publica versionada — so o CRX fica de fora, com aviso.
 *
 *   node scripts/build.mjs
 */
import { criarZip } from './lib/zip.mjs';
import { criarCrx, lerChavePrivada, derPublico, idDaExtensao, chaveDoManifest } from './lib/crx.mjs';
import {
  fs, path, RAIZ, SRC, DIST, SITE, CONFIG,
  ARQ_CHAVE_PUBLICA, ARQ_CHAVE_PRIVADA,
  arquivosDaExtensao, pacote, urlBase, repositorio, lerJson, cor
} from './lib/comum.mjs';

const pkg = pacote();
const versao = pkg.version;
const base = urlBase();
const repo = repositorio();

console.log('\n  IMPRESSORA ENVIAGORA — build v' + versao + '\n');

// ── 1. Chave ────────────────────────────────────────────────────────────────
let chavePrivada = null;
const doAmbiente = lerChavePrivada(process.env.CRX_PRIVATE_KEY);
if (doAmbiente) {
  chavePrivada = doAmbiente;
  console.log('  chave: secret CRX_PRIVATE_KEY');
} else if (fs.existsSync(ARQ_CHAVE_PRIVADA)) {
  chavePrivada = fs.readFileSync(ARQ_CHAVE_PRIVADA, 'utf8');
  console.log('  chave: ./chave-privada.pem');
}

if (!fs.existsSync(ARQ_CHAVE_PUBLICA)) {
  console.error(cor.erro('\n  Falta config/chave-publica.txt. Rode `npm run chave` uma vez.\n'));
  process.exit(1);
}
const chavePublica = fs.readFileSync(ARQ_CHAVE_PUBLICA, 'utf8').trim();
const idEsperado = idDaExtensao(Buffer.from(chavePublica, 'base64'));

// A chave privada TEM que corresponder a publica versionada. Se nao corresponder, o CRX
// sairia com outro ID e as maquinas instaladas nao reconheceriam a atualizacao — falharia
// silenciosamente, que e o pior jeito de falhar.
if (chavePrivada) {
  const derDaPrivada = derPublico(chavePrivada);
  if (chaveDoManifest(derDaPrivada) !== chavePublica) {
    console.error(cor.erro('\n  A chave privada NAO corresponde a config/chave-publica.txt.'));
    console.error('  ID que sairia: ' + idDaExtensao(derDaPrivada));
    console.error('  ID esperado:   ' + idEsperado);
    console.error('\n  Publicar assim criaria uma extensao diferente e as 60 maquinas parariam');
    console.error('  de receber atualizacao, sem erro visivel. Build abortado.\n');
    process.exit(1);
  }
}

console.log('  ID da extensao: ' + cor.ok(idEsperado));

// ── 2. Manifests ────────────────────────────────────────────────────────────
const manifestBase = lerJson(path.join(SRC, 'manifest.json'));
manifestBase.version = versao;

const urlUpdate = base + 'updates.xml';

const manifestAuto = { ...manifestBase, key: chavePublica, update_url: urlUpdate };
// A Web Store recusa manifest com update_url (ela mesma cuida da atualizacao) e nao
// precisa do "key": o ID vem da conta de publicacao.
const manifestLoja = { ...manifestBase };
delete manifestLoja.key;
delete manifestLoja.update_url;

// ── 3. ZIPs ─────────────────────────────────────────────────────────────────
const arquivos = arquivosDaExtensao();

// Menu da operação (src/menu/config.js): a API key do Firebase e o client_id do OAuth do projeto
// menu-enviagora sao identificadores PUBLICOS, mas ficam fora do git para nao parecerem segredo
// vazado num repo publico. Vem das variaveis do repo (Settings -> Variables -> Actions). Sem elas o
// menu abre normal (leitura publica); so o "Editar menu" nao consegue entrar. No release (EXIGIR_CRX)
// a falta delas aborta, para nao publicar uma versao em que o PCP nao consegue editar.
// trim() tira tambem o BOM (U+FEFF): a 16.37.1 saiu com a chave colada com BOM e nenhum login novo
// passava ("API key not valid"). O formato e conferido abaixo para isso nao voltar calado.
const menuIds = { __API_KEY__: (process.env.MENU_API_KEY || '').trim(), __OAUTH_CLIENT_ID__: (process.env.MENU_OAUTH_CLIENT_ID || '').trim() };
const formatoMenu = { __API_KEY__: /^AIza[0-9A-Za-z_-]{35}$/, __OAUTH_CLIENT_ID__: /^[0-9]+-[0-9a-z]+\.apps\.googleusercontent\.com$/ };
const invalidoMenu = Object.entries(menuIds).filter(([k, v]) => v && !formatoMenu[k].test(v)).map(([k]) => k);
if (invalidoMenu.length) {
  console.error(cor.erro('\n  Formato invalido em ' + invalidoMenu.join(' e ') + ' (variaveis do repo: espaco ou caractere invisivel?). Build abortado.\n'));
  process.exit(1);
}
const faltaMenu = Object.entries(menuIds).filter(([, v]) => !v).map(([k]) => k === '__API_KEY__' ? 'MENU_API_KEY' : 'MENU_OAUTH_CLIENT_ID');
if (faltaMenu.length && process.env.EXIGIR_CRX) {
  console.error(cor.erro('\n  Faltam ' + faltaMenu.join(' e ') + ' (variaveis do repo). Sem elas o "Editar menu" nao entra. Build abortado.\n'));
  process.exit(1);
}
if (faltaMenu.length) console.log('  ' + cor.aviso('menu') + ' — sem ' + faltaMenu.join(' e ') + ': o "Editar menu" nao vai conseguir entrar neste pacote.');
for (const a of arquivos) {
  if (a.nome !== 'menu/config.js') continue;
  let txt = a.dados.toString('utf8');
  for (const [marcador, valor] of Object.entries(menuIds)) if (valor) txt = txt.replace(marcador, valor);
  a.dados = Buffer.from(txt, 'utf8');
}
const semManifest = arquivos.filter((a) => a.nome !== 'manifest.json');

const comManifest = (m) => [
  ...semManifest,
  { nome: 'manifest.json', dados: Buffer.from(JSON.stringify(m, null, 2) + '\n', 'utf8') }
];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const nomeAuto = 'impressora-enviagora-' + versao + '.zip';
const nomeLoja = 'impressora-enviagora-' + versao + '-webstore.zip';

const zipAuto = criarZip(comManifest(manifestAuto));
const zipLoja = criarZip(comManifest(manifestLoja));

fs.writeFileSync(path.join(DIST, nomeAuto), zipAuto);
fs.writeFileSync(path.join(DIST, nomeLoja), zipLoja);

const kb = (b) => (b.length / 1024).toFixed(0) + ' KB';
console.log('  ' + cor.ok(nomeAuto.padEnd(42)) + kb(zipAuto) + '  (auto-hospedado)');
console.log('  ' + cor.ok(nomeLoja.padEnd(42)) + kb(zipLoja) + '  (Web Store, plano B)');

// ── 4. CRX ──────────────────────────────────────────────────────────────────
let temCrx = false;
if (chavePrivada) {
  const { crx, id } = criarCrx(zipAuto, chavePrivada);
  if (id !== idEsperado) {
    console.error(cor.erro('\n  ID divergente apos assinar. Build abortado.\n'));
    process.exit(1);
  }
  const nomeCrx = 'impressora-enviagora-' + versao + '.crx';
  fs.writeFileSync(path.join(DIST, nomeCrx), crx);
  console.log('  ' + cor.ok(nomeCrx.padEnd(42)) + kb(crx) + '  (assinado)');
  temCrx = true;
} else {
  console.log('  ' + cor.aviso('.crx nao gerado') + ' — sem CRX_PRIVATE_KEY nem ./chave-privada.pem.');
  console.log('  ' + cor.fraco('Os ZIPs acima estao validos e usam o ID correto.'));
}

// ── 5. updates.xml ──────────────────────────────────────────────────────────
// O codebase aponta para o CRX anexado ao Release da tag correspondente. E esse endereco
// que o Chrome consulta a cada poucas horas para saber se ha versao nova.
const nomeCrxRelease = 'impressora-enviagora-' + versao + '.crx';
const urlCrx = 'https://github.com/' + repo + '/releases/download/v' + versao + '/' + nomeCrxRelease;

const updatesXml = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Gerado por scripts/build.mjs. Nao edite a mao: o proximo build sobrescreve. -->
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="${idEsperado}">
    <updatecheck codebase="${urlCrx}" version="${versao}" />
  </app>
</gupdate>
`;

// So em dist/. O updates.xml que vai ao ar e montado por scripts/gerar-site.mjs, a
// partir do ultimo Release publicado — versionar um gerado aqui so criaria dois donos
// para o mesmo arquivo e uma chance de eles discordarem.
fs.writeFileSync(path.join(DIST, 'updates.xml'), updatesXml, 'utf8');

// ── 6. Resumo ───────────────────────────────────────────────────────────────
console.log('\n  atualizacao: ' + base + 'updates.xml');
console.log('  download:    ' + base);
console.log('  CRX no Release: ' + urlCrx + '\n');

// Aborta so quando quem chamou DECLAROU que precisa do CRX — o release.yml passa
// EXIGIR_CRX=1. A trava nao pode ser por process.env.CI: o ci.yml roda este build de
// proposito SEM a chave, so para conferir que o pacote monta, e ali a ausencia do CRX e
// o comportamento esperado, nao um erro.
if (!temCrx && process.env.EXIGIR_CRX === '1') {
  console.error(cor.erro('  Faltou a chave privada e este build PRECISA do CRX.'));
  console.error(cor.erro('  Sem ele o Release sai incompleto e nenhuma maquina atualiza.'));
  console.error(cor.erro('  Configure o secret CRX_PRIVATE_KEY. Build abortado.\n'));
  process.exit(1);
}

console.log(cor.ok('  Build concluido.\n'));

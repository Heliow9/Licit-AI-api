// scripts/smoke-match.js
// Teste por TEXTO usando o gate oficial do service (sameDomainGate)
// Mostra domínios para debug, mas o gate NÃO usa interseção crua do detectDomain.

const catsSvc = require('../src/services/cats');
const {
  sameDomainGate,
  detectDomain,
  detectTechnicalDomains,
  // opcional: detectModalities
} = catsSvc;

function setToStr(set){ return set && set.size ? [...set].join(',') : '∅'; }

// ======== DADOS DE TESTE ========
const editalPet = `
Objeto: Fornecimento de areia higiênica para gatos (litter) com entrega programada.
Termo de referência: areia sanitária para felinos, embalagens 5kg e 10kg, controle de qualidade.
`;

const editalEletrica = `
Serviços de intervenção energizada em linhas de transmissão e subestações, tensões 138 e 230kV,
com substituição de isoladores, ferragens das cadeias de suspensão e inspeção termográfica.
`;

const CATS = [
  { id: 'CAT01-PET', txt: `Fornecimento de areia higiênica para gatos (litter) grau sanitário. Transporte e armazenamento.` },
  { id: 'CAT02-CIVIL', txt: `Execução de obra civil com alvenaria estrutural, concreto armado, revestimentos e acabamentos.` },
  { id: 'CAT03-SAN', txt: `Manutenção de adutoras, ETA, troca de válvulas e bombas de recalque, testes de estanqueidade.` },
  { id: 'CAT04-ELE', txt: `Intervenção energizada em linhas de transmissão 138 e 230kV, substituição de isoladores e ferragens.` },
];

// fallback simples p/ score visual
function semanticScore(a, b){
  const tokw = s => (s||'').toLowerCase().split(/\W+/).filter(Boolean);
  const A = new Set(tokw(a)), B = new Set(tokw(b));
  const inter = [...A].filter(x=>B.has(x)).length;
  const denom = Math.sqrt(A.size*B.size)||1;
  let s = inter/denom;
  if (/\bareia higiênica\b/i.test(a) && /\bareia higiênica\b/i.test(b)) s += 0.2;
  if (/(138|230|500)\s?kv/i.test(a) && /(138|230|500)\s?kv/i.test(b)) s += 0.2;
  return Math.min(1, s);
}

function test(editalText, label) {
  console.log(`\n=== TESTE: ${label} ===`);
  const domE_all = detectDomain(editalText);
  const domE_tech = detectTechnicalDomains(editalText);
  for (const cat of CATS) {
    const domC_all = detectDomain(cat.txt);
    const domC_tech = detectTechnicalDomains(cat.txt);
    const passGate = sameDomainGate(editalText, cat.txt); // <- usa o gate do service
    const score = passGate ? semanticScore(editalText, cat.txt) : 0;
    console.log(
      `${passGate ? 'GATE✅' : 'GATE❌'}  ${cat.id}  score=${score.toFixed(2)}  ` +
      `domEditalAll={${setToStr(domE_all)}} domEditalTech={${setToStr(domE_tech)}}  ` +
      `domCATAll={${setToStr(domC_all)}} domCATTech={${setToStr(domC_tech)}}`
    );
  }
  console.log('---');
}

test(editalPet, 'Edital PET (areia higiênica)');
test(editalEletrica, 'Edital Elétrica (LT/Subestação)');

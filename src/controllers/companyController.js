// src/controllers/companyController.js
const Companies = require('../models/companyModel');
// ===== helper de id =====
const oid = (v) => (typeof v === 'string' ? new ObjectId(v) : v);

// ===== DEFAULT CHECKLIST (pode ajustar livremente) =====
function defaultComplianceChecklist() {
  return {
    habilitacaoJuridica: {
      contratoSocial: true,
      cnpjAtivo: true,
      procuracao: false,
    },
    regularidadeFiscalTrabalhista: {
      receitaPgfn: true,
      cndPrevidenciaria: true,
      crfFgts: true,
      icms: false,
      iss: true,
      cndt: true,
    },
    econFinanceira: {
      balancoPatrimonial: true,
      certidaoFalencia: true,
      capitalMinimoOuPL: false,
    },
    qualificacaoTecnica: {
      atestadosCapacidade: true,
      artRrtCat: true,
      registroConselho: false,
      responsavelTecnico: false,
    },
    declaracoes: {
      propostaIndependente: true,
      inexistenciaFatoImped: true,
      menorAprendizRegras: true,
      enquadramentoMeEpp: false,
      cumprimentoEditalAnticorrupcao: true,
      credenciamentoPreposto: true,
    },
    adicionais: {
      vistoriaTecnica: false,
      certificacoesRegulatorios: false,
      planoTrabalhoMetodologia: false,
      garantiaProposta: false,
      garantiaContratual: true,
      seguros: false,
    },
    observacoes: ''
  };
}

// ===== GET /api/company/my/checklist =====
async function getComplianceChecklist(req, res) {
  try {
    const db = await getDb();
    const comp = await db.collection('companies').findOne(
      { _id: oid(req.companyId) },
      { projection: { complianceChecklist: 1 } }
    );

    const checklist = comp?.complianceChecklist || defaultComplianceChecklist();
    return res.json({ checklist });
  } catch (e) {
    console.error('getComplianceChecklist error:', e);
    return res.status(500).json({ error: 'Falha ao carregar checklist.' });
  }
}

// ===== PATCH /api/company/my/checklist =====
// Somente owner/admin (o middleware de auth deve garantir role)
async function updateComplianceChecklist(req, res) {
  try {
    const incoming = req.body?.checklist || {};
    // sanity: só aceita boolean/string dentro das chaves conhecidas
    const base = defaultComplianceChecklist();

    // função recursiva de merge “seguro”
    const mergeSafe = (dst, src) => {
      for (const k of Object.keys(dst)) {
        if (typeof dst[k] === 'object' && dst[k] !== null && !Array.isArray(dst[k])) {
          if (src && typeof src[k] === 'object') mergeSafe(dst[k], src[k]);
        } else if (typeof dst[k] === 'boolean') {
          if (typeof src?.[k] === 'boolean') dst[k] = src[k];
        } else if (typeof dst[k] === 'string') {
          if (typeof src?.[k] === 'string') dst[k] = String(src[k]).slice(0, 5000);
        }
      }
      return dst;
    };

    const sanitized = mergeSafe(base, incoming);

    const db = await getDb();
    await db.collection('companies').updateOne(
      { _id: oid(req.companyId) },
      { $set: { complianceChecklist: sanitized, updatedAt: new Date() } }
    );

    return res.json({ ok: true, checklist: sanitized });
  } catch (e) {
    console.error('updateComplianceChecklist error:', e);
    return res.status(500).json({ error: 'Falha ao salvar checklist.' });
  }
}
function sanitizeCompany(c) {
  if (!c) return null;
  const { _id, name, cnpj, contact, address, plan, createdBy, createdAt, updatedAt } = c;
  return {
    id: String(_id),
    name,
    cnpj,
    contact: contact || {},
    address: address || {},
    plan: plan || 'free',
    createdBy: createdBy ? String(createdBy) : null,
    createdAt,
    updatedAt,
  };
}

async function getMyCompany(req, res) {
  try {
    const { companyId } = req.auth || {};
    if (!companyId) return res.status(404).json({ error: 'Usuário não possui empresa vinculada.' });
    const company = await Companies.findById(companyId);
    if (!company) return res.status(404).json({ error: 'Empresa não encontrada.' });
    return res.json({ company: sanitizeCompany(company) });
  } catch (e) {
    console.error('getMyCompany error:', e);
    return res.status(500).json({ error: 'Erro ao carregar empresa.' });
  }
}

async function updateMyCompany(req, res) {
  try {
    const { companyId } = req.auth || {};
    if (!companyId) return res.status(404).json({ error: 'Usuário não possui empresa vinculada.' });

    const allowed = {};
    const { name, contact, address } = req.body || {};
    if (name !== undefined) allowed.name = name;
    if (contact && typeof contact === 'object') allowed.contact = contact;
    if (address && typeof address === 'object') allowed.address = address;
    allowed.updatedAt = new Date();

    const updated = await Companies.updateById(companyId, allowed);
    return res.json({ company: sanitizeCompany(updated) });
  } catch (e) {
    console.error('updateMyCompany error:', e);
    return res.status(500).json({ error: 'Erro ao atualizar empresa.' });
  }
}

module.exports = { getMyCompany, updateMyCompany };

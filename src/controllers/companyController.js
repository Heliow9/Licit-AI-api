// src/controllers/companyController.js
const Companies = require('../models/companyModel');

/* ========= default checklist ========= */
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

/* ========= helpers ========= */
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

// merge seguro mantendo estrutura e tipos
function mergeChecklist(base, incoming) {
  const dst = JSON.parse(JSON.stringify(base));
  const walk = (d, s) => {
    Object.keys(d).forEach((k) => {
      const dv = d[k];
      const sv = s?.[k];
      if (dv && typeof dv === 'object' && !Array.isArray(dv)) {
        walk(dv, sv);
      } else if (typeof dv === 'boolean') {
        if (typeof sv === 'boolean') d[k] = sv;
      } else if (typeof dv === 'string') {
        if (typeof sv === 'string') d[k] = String(sv).slice(0, 5000);
      }
    });
  };
  walk(dst, incoming || {});
  return dst;
}

/* ========= company: get/update ========= */
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

/* ========= checklist: get/update ========= */
async function getComplianceChecklist(req, res) {
  try {
    const { companyId } = req.auth || {};
    if (!companyId) return res.status(404).json({ error: 'Usuário não possui empresa vinculada.' });

    const company = await Companies.findById(companyId);
    const checklist = company?.complianceChecklist || defaultComplianceChecklist();

    // opcional: persiste default se não existir ainda
    if (!company?.complianceChecklist) {
      try {
        await Companies.updateById(companyId, {
          complianceChecklist: checklist,
          updatedAt: new Date()
        });
      } catch (_) {}
    }

    return res.json({ checklist });
  } catch (e) {
    console.error('getComplianceChecklist error:', e);
    return res.status(500).json({ error: 'Falha ao carregar checklist.' });
  }
}

async function updateComplianceChecklist(req, res) {
  try {
    const { companyId } = req.auth || {};
    if (!companyId) return res.status(404).json({ error: 'Usuário não possui empresa vinculada.' });

    const incoming = req.body?.checklist || {};
    const base = defaultComplianceChecklist();
    const sanitized = mergeChecklist(base, incoming);

    const updated = await Companies.updateById(companyId, {
      complianceChecklist: sanitized,
      updatedAt: new Date()
    });

    const out = updated?.complianceChecklist || sanitized;
    return res.json({ ok: true, checklist: out });
  } catch (e) {
    console.error('updateComplianceChecklist error:', e);
    return res.status(500).json({ error: 'Falha ao salvar checklist.' });
  }
}

module.exports = {
  getMyCompany,
  updateMyCompany,
  getComplianceChecklist,
  updateComplianceChecklist,
};

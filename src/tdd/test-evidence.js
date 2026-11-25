process.env.DEBUG_EVIDENCE = 'evidence';

const { findEvidenceOnTheFly /*, analyzeRequirementWithContext*/ } = require('../services/evidence');

(async () => {
  const requirement = 'Apresentar atestado de capacidade técnica e ART do responsável técnico.';
  const files = [
    {
      source: 'ANEXO_TESTE.pdf',
      getText: async () => `
        CERTIDÃO DE ACERVO TÉCNICO (CAT)
        Atestado de capacidade técnica emitido por órgão público.
        Serviços de manutenção predial executados com emissão de ART no CREA.
      `,
    },
  ];

  const hits = await findEvidenceOnTheFly(requirement, files, null); // sem Mongo
  console.log('\n[test] HITS:\n', hits);

  // Se quiser testar a análise textual e você tiver o chatText configurado:
  // const analysis = await analyzeRequirementWithContext(requirement, hits, {}, { isEngineering: true });
  // console.log('\n[test] ANALYSIS BLOCK:\n', analysis);
})();

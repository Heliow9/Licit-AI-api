const { gerarPdf } = require('./editalController');

async function gerarPdfFromBody(req, res) {
  try {
    const { markdown = '' } = req.body || {};
    if (!markdown.trim()) return res.status(400).json({ error: 'Envie o campo "markdown".' });
    const { publicUrl, filePath, filename } = await gerarPdf(markdown);
    return res.json({ pdf: { url: publicUrl, path: filePath, filename } });
  } catch (e) {
    return res.status(500).json({ error: 'Falha ao gerar PDF.', details: e.message });
  }
}
module.exports = { gerarPdfFromBody };

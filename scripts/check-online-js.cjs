const https = require('https')

https.get('https://wow.xn--fpr224a.mom/assets/index-DSZqPG-E.js', (res) => {
  let data = ''
  res.on('data', (chunk) => data += chunk)
  res.on('end', () => {
    const patterns = [
      'mergeDict("zh"',
      'mergeDict(zh',
      'admin.f.download.hint',
      'post.download.title',
      'export.toc',
      'egg.dl.html',
      '开放下载',
      'Allow downloads',
      'post-download-btn',
      'egg-download-fab',
      'handleEggPrint',
      'handleEggHtml',
      'saveBlob',
      'downloadDocx',
      'downloadMarkdown',
      'downloadHtml'
    ]
    for (const p of patterns) {
      const idx = data.indexOf(p)
      console.log(p + ':', idx >= 0 ? 'FOUND at ' + idx : 'NOT FOUND')
    }
  })
}).on('error', (e) => console.error(e))

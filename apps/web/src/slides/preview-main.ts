import '@fontsource/m-plus-1p/400.css'
import '@fontsource/m-plus-1p/700.css'
import '@canvcode/slides/slide.css'
import '@canvcode/slides/browser'

const marker = document.createElement('span')
marker.id = 'mplus-font'
marker.hidden = true
marker.dataset.status = 'pending'
document.body.append(marker)
void document.fonts.load('400 16px "M PLUS 1p"').then(() => {
  marker.dataset.status = 'loaded'
}).catch(() => {
  marker.dataset.status = 'error'
})

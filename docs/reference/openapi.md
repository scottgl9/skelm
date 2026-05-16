---
title: OpenAPI
aside: false
outline: false
---

# OpenAPI

The gateway's HTTP surface is described by an OpenAPI 3.1 spec. The rendered reference below is the canonical contract for `/v1/*` endpoints — request bodies, response shapes, status codes, error envelopes.

[Download spec (YAML)](/skelm/openapi.yaml)

<ClientOnly>
  <div id="redoc-container"></div>
</ClientOnly>

<script setup>
import { onMounted } from 'vue'
import { withBase } from 'vitepress'

onMounted(() => {
  const specUrl = withBase('/openapi.yaml')
  const mount = () => {
    if (typeof window.Redoc === 'undefined') {
      setTimeout(mount, 50)
      return
    }
    window.Redoc.init(specUrl, { hideDownloadButton: true, theme: { colors: { primary: { main: '#3c8772' } } } }, document.getElementById('redoc-container'))
  }
  mount()
})
</script>

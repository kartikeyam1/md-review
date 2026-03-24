import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FileUpload from '@/components/FileUpload.vue'

describe('FileUpload', () => {
  it('renders upload area with instructions', () => {
    const wrapper = mount(FileUpload)
    expect(wrapper.text()).toContain('Drop your file here')
    expect(wrapper.text()).toContain('.md')
  })

  it('shows paste and blank options', () => {
    const wrapper = mount(FileUpload)
    expect(wrapper.text()).toContain('Paste markdown')
    expect(wrapper.text()).toContain('Start blank')
  })

  it('emits file-loaded on valid file', async () => {
    const wrapper = mount(FileUpload)
    const file = new File(['# Hello'], 'test.md', { type: 'text/markdown' })

    const input = wrapper.find('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [file] })
    await input.trigger('change')

    // Wait for FileReader
    await new Promise((r) => setTimeout(r, 50))

    expect(wrapper.emitted('file-loaded')).toBeTruthy()
    expect(wrapper.emitted('file-loaded')![0]).toEqual(['# Hello', 'test.md'])
  })

  it('emits file-loaded with blank content when Start blank clicked', async () => {
    const wrapper = mount(FileUpload)
    const blankBtn = wrapper.findAll('button').find((b) => b.text() === 'Start blank')
    expect(blankBtn).toBeTruthy()
    await blankBtn!.trigger('click')
    expect(wrapper.emitted('file-loaded')).toBeTruthy()
    expect(wrapper.emitted('file-loaded')![0]).toEqual(['', 'untitled.md'])
  })
})

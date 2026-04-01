import { chromium } from 'playwright'
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

const BASE = 'http://localhost:4175'
const API = 'http://localhost:3100'

let browser, context, page

// Create a test session via API
async function createTestSession() {
  const res = await fetch(`${API}/paste`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      markdown: '# QA Gate Test\n\n## Section 1\nThis needs review.\n\n## Section 2\nLooks good.',
      filename: 'qa-gate-test.md',
      sessionName: 'QA Gate Feature Test',
    }),
  })
  const data = await res.json()

  // Add a must-fix comment
  await fetch(`${API}/paste/${data.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startLine: 3, endLine: 3,
      selectedText: 'This needs review.',
      body: 'Must fix this before shipping',
      category: 'must-fix',
    }),
  })

  // Add a suggestion
  await fetch(`${API}/paste/${data.id}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startLine: 5, endLine: 5,
      selectedText: 'Looks good.',
      body: 'Consider adding more detail',
      category: 'suggestion',
    }),
  })

  return data
}

describe('Gate + Speed features', () => {
  let session

  before(async () => {
    browser = await chromium.launch({ args: ['--no-sandbox'] })
    context = await browser.newContext()
    page = await context.newPage()
    session = await createTestSession()
  })

  after(async () => {
    await browser?.close()
  })

  describe('slug-based URLs', () => {
    it('loads session by slug', async () => {
      await page.goto(`${BASE}/#shared=${session.slug}`)
      await page.waitForTimeout(2000)
      const content = await page.textContent('.app')
      assert.ok(content.includes('QA Gate Test'), 'Should show markdown content')
    })

    it('loads session by hex ID', async () => {
      await page.goto(`${BASE}/#shared=${session.id}`)
      await page.waitForTimeout(2000)
      const content = await page.textContent('.app')
      assert.ok(content.includes('QA Gate Test'), 'Should show markdown content')
    })
  })

  describe('approval banner', () => {
    it('shows pending status badge', async () => {
      await page.goto(`${BASE}/#shared=${session.slug}`)
      await page.waitForTimeout(2000)
      const banner = page.locator('.approval-banner')
      await banner.waitFor({ state: 'visible', timeout: 5000 })
      const badge = await page.textContent('.status-badge')
      assert.ok(badge.includes('Pending'), `Badge should say Pending, got: ${badge}`)
    })

    it('has approve and request changes buttons', async () => {
      const approveBtn = page.locator('.btn.approve')
      const changesBtn = page.locator('.btn.request-changes')
      await assert.ok(await approveBtn.isVisible(), 'Approve button visible')
      await assert.ok(await changesBtn.isVisible(), 'Request Changes button visible')
    })

    it('approve button is disabled when must-fix unresolved', async () => {
      // Type a name first
      await page.fill('.reviewer-input', 'tester')
      const disabled = await page.locator('.btn.approve').isDisabled()
      assert.ok(disabled, 'Approve should be disabled with unresolved must-fix')
    })
  })

  describe('summary panel', () => {
    it('shows review summary with comment counts', async () => {
      await page.goto(`${BASE}/#shared=${session.slug}`)
      await page.waitForTimeout(2000)
      const panel = page.locator('.summary-panel')
      await panel.waitFor({ state: 'visible', timeout: 5000 })
      const text = await panel.textContent()
      assert.ok(text.includes('Review Summary'), 'Should show Review Summary title')
      assert.ok(text.includes('Must Fix'), 'Should show Must Fix count')
      assert.ok(text.includes('Suggestion'), 'Should show Suggestion count')
    })

    it('shows needs attention section for must-fix', async () => {
      const attention = page.locator('.attention')
      const visible = await attention.isVisible()
      assert.ok(visible, 'Attention section should be visible when must-fix comments exist')
    })

    it('can collapse and expand', async () => {
      await page.click('.summary-toggle')
      await page.waitForTimeout(300)
      const content = page.locator('.summary-content')
      assert.ok(!(await content.isVisible()), 'Content should be hidden after collapse')
      await page.click('.summary-toggle')
      await page.waitForTimeout(300)
      assert.ok(await content.isVisible(), 'Content should be visible after expand')
    })
  })

  describe('comment resolution', () => {
    it('shows resolve button on comments', async () => {
      await page.goto(`${BASE}/#shared=${session.slug}`)
      await page.waitForTimeout(2000)
      const resolveBtn = page.locator('.resolve-btn').first()
      await resolveBtn.waitFor({ state: 'visible', timeout: 5000 })
      assert.ok(await resolveBtn.isVisible(), 'Resolve button should be visible')
    })

    it('resolves a comment and shows resolved state', async () => {
      const resolveBtn = page.locator('.resolve-btn').first()
      await resolveBtn.click()
      await page.waitForTimeout(1000)
      const resolvedCard = page.locator('.comment-card.resolved').first()
      assert.ok(await resolvedCard.isVisible(), 'Comment should have resolved class')
    })

    it('shows unresolve button on resolved comments', async () => {
      const unresolveBtn = page.locator('.unresolve-btn').first()
      assert.ok(await unresolveBtn.isVisible(), 'Unresolve button should appear')
    })
  })

  describe('approval after resolution', () => {
    it('enables approve after all must-fix resolved', async () => {
      // Resolve all must-fix comments via API
      const commentsRes = await fetch(`${API}/paste/${session.id}/comments`)
      const { comments } = await commentsRes.json()
      for (const c of comments) {
        if (c.category === 'must-fix' && !c.resolved) {
          await fetch(`${API}/paste/${session.id}/comments/${c.id}/resolve`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resolved_by: 'qa-test' }),
          })
        }
      }

      // Reload page to pick up changes
      await page.goto(`${BASE}/#shared=${session.slug}`)
      await page.waitForTimeout(3000)

      await page.fill('.reviewer-input', 'qa-tester')
      await page.waitForTimeout(500)
      const disabled = await page.locator('.btn.approve').isDisabled()
      assert.ok(!disabled, 'Approve should be enabled after all must-fix resolved')
    })

    it('approves and shows approved badge', async () => {
      await page.click('.btn.approve')
      await page.waitForTimeout(2000)
      const badge = await page.textContent('.status-badge')
      assert.ok(badge.includes('Approved'), `Badge should say Approved, got: ${badge}`)
    })
  })

  describe('dashboard', () => {
    it('loads dashboard at /#dashboard', async () => {
      // Create a pending session for dashboard
      await fetch(`${API}/paste`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          markdown: '# Dashboard Test',
          filename: 'dashboard.md',
          sessionName: 'Dashboard Pending Session',
        }),
      })

      await page.goto(`${BASE}/#dashboard`)
      await page.waitForTimeout(2000)
      const heading = await page.textContent('.dashboard-header h2')
      assert.equal(heading, 'Pending Reviews')
    })

    it('shows pending sessions', async () => {
      const cards = page.locator('.session-card')
      const count = await cards.count()
      assert.ok(count > 0, `Should show at least 1 pending session, got: ${count}`)
    })

    it('clicking a session navigates to review', async () => {
      await page.locator('.session-card').first().click()
      await page.waitForTimeout(2000)
      const hash = await page.evaluate(() => window.location.hash)
      assert.ok(hash.startsWith('#shared='), `Should navigate to shared view, got: ${hash}`)
    })
  })
})

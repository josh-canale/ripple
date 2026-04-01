'use client'

import dynamic from 'next/dynamic'

const DotGrid = dynamic(() => import('@/components/canvas/DotGrid'), { ssr: false })

export default function Home() {
  return (
    <main>
      <DotGrid />
    </main>
  )
}

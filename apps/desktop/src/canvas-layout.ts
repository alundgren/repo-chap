import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode, ElkExtendedEdge, ElkPoint, ELK as ElkEngine } from 'elkjs';

export interface CanvasLayoutNode { id: string; width: number; height: number }
export interface CanvasLayoutEdge { from: string; to: string; label: string; failure: boolean }
export interface CanvasLayout {
  width: number; height: number;
  nodes: Map<string, { x: number; y: number; width: number; height: number }>;
  edges: { points: ElkPoint[]; labelX: number; labelY: number }[];
}

// elkjs ships CommonJS; its constructor declaration resolves as a namespace under NodeNext.
const ElkConstructor = ELK as unknown as { new(): ElkEngine };
const elk = new ElkConstructor();
export async function layoutCanvas(nodes: CanvasLayoutNode[], edges: CanvasLayoutEdge[]): Promise<CanvasLayout> {
  const graph: ElkNode = {
    id: 'workflow',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=35,left=35,bottom=35,right=35]',
      'elk.spacing.nodeNode': '50',
      'elk.spacing.edgeNode': '24',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.crossingMinimization.greedySwitch.type': 'TWO_SIDED',
      'elk.layered.thoroughness': '20',
      'elk.randomSeed': '1',
    },
    children: nodes.map(node => ({
      ...node,
      layoutOptions: { 'elk.portConstraints': 'FIXED_SIDE' },
      ports: [
        ...edges.flatMap((edge, index) => edge.to === node.id ? [{ id: `in-${index}`, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'WEST' } }] : []),
        ...edges.flatMap((edge, index) => edge.from === node.id ? [{ id: `out-${index}`, width: 0, height: 0, layoutOptions: { 'elk.port.side': edge.failure ? 'SOUTH' : 'EAST' } }] : []),
      ],
    })),
    edges: edges.map((edge, index): ElkExtendedEdge => ({
      id: String(index), sources: [`out-${index}`], targets: [`in-${index}`],
      labels: [{ text: edge.label, width: edge.label.length * 7.1, height: 19 }],
    })),
  };
  const result = await elk.layout(graph);
  return {
    width: result.width!, height: result.height!,
    nodes: new Map(result.children!.map(node => [node.id, { x: node.x! + node.width! / 2, y: node.y! + node.height! / 2, width: node.width!, height: node.height! }])),
    edges: edges.map((_edge, index) => {
      const edge = result.edges!.find(edge => edge.id === String(index))!;
      const route = edge.sections![0]!;
      const label = edge.labels![0]!;
      return { points: [route.startPoint, ...route.bendPoints ?? [], route.endPoint], labelX: label.x! + label.width! / 2, labelY: label.y! + 14 };
    }),
  };
}

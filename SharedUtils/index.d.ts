export function parseIngredients(ingredients: string, scale: number, boldify?: boolean): {
  content: string,
  originalContent: string,
  complete: boolean,
  isHeader: boolean
}[];

export function parseInstructions(instructions: string): {
  content: string,
  isHeader: boolean,
  count: number,
  complete: boolean
}[];

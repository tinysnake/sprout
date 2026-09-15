# Minesweeper design

The board is a compact 9 by 9 puzzle with 10 mines. Reveal every safe cell to
win; a revealed mine ends the game, and **New board** starts over. The first
reveal and its neighbours are mine-free so every game has a fair opening.

Primary pointer input reveals a covered cell. Secondary pointer input toggles a
flag without revealing it, and the live counter subtracts flags from the mine
total. Status text announces normal, won, and lost states.

The canvas has an accessible name explaining the controls. Nearby text repeats
the instructions, counter, and status. Covered, flagged, revealed, and mine
cells use distinct colours and shapes, so state is not conveyed by colour alone.

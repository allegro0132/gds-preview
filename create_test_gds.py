import gdstk

# Create a library
lib = gdstk.Library()

# Create a cell
cell = lib.new_cell('RECTANGLES')

# Create a rectangle on layer 0
rect1 = gdstk.rectangle((0, 0), (10, 20), layer=0, datatype=0)
cell.add(rect1)

# Create another rectangle on layer 1
rect2 = gdstk.rectangle((15, 0), (25, 20), layer=1, datatype=0)
cell.add(rect2)

# Save the library to a GDS file
lib.write_gds('test.gds')

print("Created test.gds")

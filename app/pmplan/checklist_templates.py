"""Version 2 of monthly inspection templates (PM check sheet Updated.xls).

Workbook guidance is reference material, not approved operating limits or permission
for electrical work. Existing task strings are stable identifiers for evidence and
corrective issues. Equivalent workbook items enrich those strings rather than replace
them; distinct legacy checks are retained. Combined visits remain single activities.
"""

TEMPLATE_VERSION = "2026-12-v2"

LEGACY_CHECKLISTS = {'Inverter': ['Check inverter cleanliness',
              'Check tourqing of AC Termination',
              'Check All cooling fans are working',
              'String testig to be done - And Make String Report',
              'Check any abnormilities (Cable puncher,crack in cable insulation)',
              'Check Inverter Communication with RMS/COM100',
              'ERT of All DC Earthing Pits',
              'Check DC On/Off Switch',
              'Check Cable entry hole seald by PV Foam',
              'Module cleanning robot inspection',
              'Modules physical inspection- For any Damage',
              'Check/visually inspect the inverter-side MC4. Ensure all MC4 connectors are properly locked. '
              'Perform a string check to identify any cuts in the DC cable.',
              'MMS check ( rusting, wending nut bolts lossing)',
              'Cleaning of fan filter units'],
 'ACCB': ['Check ACCB fuse base',
          'Check Bus Bar Sleeve',
          'Check Bus Bar Bolt, Lug, Washer for Heat Up & Looseness',
          'Check Fan is working',
          'Check Power cable lug',
          'Check Fuse base connection tightness',
          'Check Temp. in ACCB',
          'Check Fuse failure',
          'Check ACCB cleanliness',
          'Check Acrylic sheet mounting',
          'Check Air filter & fan filter for cleanliness',
          'Check Cable dressing',
          'Check Door lock & Door working',
          'Check LED Indication',
          'Check for any unwanted opening or Hole',
          'Check Enclosure Rusting',
          'Check ACCB Rotary Switch is in ON condition',
          'Inspect MCBs, DPs, fuses, relays, and timers for abnormalities, burns, or overheating'],
 'IDT Transformer': ['Clean Complete Body of transformer',
                     'Check Oil Leakage from Transformer ( Radiator,Conservator, Tank and Air Release & Oil '
                     'Releive Valve)',
                     'Check Torqing of LT and HT termmination',
                     'Check Tightness of marshelling box connection',
                     'Check IR Values of HT nad LT Winding',
                     'Check tap changing take place both in Manual mode And Remote Mode',
                     'Check all the cable termination',
                     'Check OTI Alarm and Trip',
                     'Check WTI Alarm and Trip',
                     'Check Buchholz alarm and Trip',
                     'Check MOG Alarm',
                     'Check and release Air Vent in Buholz relay',
                     'Check Earth resistanse of Transformer Earthing',
                     'Visual check for any crack on Insulator',
                     'Check and remove Vegetation in the yard',
                     'Check Oil Level of transformer tank and OLTC',
                     'Check the Breather Silicagel condition'],
 'VCB': ['Check Breaker cleanliness',
         'Check Torqing of AC termination',
         'Check bolt, washer and lug for heatup',
         'Check Breaker Jointing Kit (Any Crack in Jointing Kit)',
         'Check manual Spring charge and On/Off',
         'Check operation of Breaker',
         'Check the Indication Lamp',
         'Check the Annunciator function',
         'Check the Hooter function',
         'Check the Function of Selector switch and TNC Switch and Push Button',
         'Check door lock and door working'],
 '4 Pole + ACDB + Aux. TX': ['Four Pole — Bush Should be Clear',
                             'Four Pole — Oil Leakage Issue from CT & PT',
                             'Four Pole — Yard Fencing Should be Proper',
                             'Four Pole — Grease on Isolator Operating Part',
                             'Four Pole — Equipment Bushing Proper',
                             'Four Pole — Jointing Kits Proper',
                             'Four Pole — Check ERT Value, if required fill water in pits',
                             'Four Pole — No Chattering Sound Heard in Yard',
                             'Four Pole — Yard Greet Should be Proper',
                             'Four Pole — Fire Bucket Filled with Sand & Fire Extinguisher Filled',
                             'Four Pole — Check horngap Rod and Fuse Condition',
                             'Four Pole — Check the LA is Intact',
                             'Four Pole — Visual inspection of the four-pole structure',
                             'ACDB — HT & LT Pannels Cleaning Record',
                             'ACDB — Inspect MCBs, DPs, fuses, relays, and timers for abnormalities, burns, '
                             'or overheating',
                             'Auxiliary Transformer — Clean Complete Body of transformer',
                             'Auxiliary Transformer — Check Oil Leakage from Transformer ( '
                             'Radiator,Conservator, Tank and Air Release & Oil Releive Valve)',
                             'Auxiliary Transformer — Check Torqing of LT and HT termmination',
                             'Auxiliary Transformer — Check Tightness of marshelling box connection',
                             'Auxiliary Transformer — Check IR Values of HT nad LT Winding',
                             'Auxiliary Transformer — Check tap changing take place both in Manual mode And '
                             'Remote Mode',
                             'Auxiliary Transformer — Check all the cable termination',
                             'Auxiliary Transformer — Check OTI Alarm and Trip',
                             'Auxiliary Transformer — Check WTI Alarm and Trip',
                             'Auxiliary Transformer — Check Buchholz alarm and Trip',
                             'Auxiliary Transformer — Check MOG Alarm',
                             'Auxiliary Transformer — Check and release Air Vent in Buholz relay',
                             'Auxiliary Transformer — Check Earth resistanse of Transformer Earthing',
                             'Auxiliary Transformer — Visual check for any crack on Insulator',
                             'Auxiliary Transformer — Check and remove Vegetation in the yard',
                             'Auxiliary Transformer — Check Oil Level of transformer tank and OLTC',
                             'Auxiliary Transformer — Check the Breather Silicagel condition'],
 'Transmission line': ['Check the insulator crackness from Ground',
                       'Check conductor Sag from Ground',
                       'Check and ensure the pole & Pin insulators are upright and free from slantinng from '
                       'Ground',
                       'Check and ensure poles are with out any damage/observation from Ground',
                       'Check and cut trees and shrubs during line clearance',
                       'Check conductors are properly seated in its slot from Ground',
                       'Check earth connection to the poles from Ground',
                       'Check the guard wire for properness from Ground',
                       'Check the stay insulator healthiness and stay wire properness',
                       'Check all jointing kits visually',
                       'Complete line patrolling from the plant to GSS',
                       'Check arcing horn for any carbon deposits'],
 'GSS visit': ['GSS-side VCB & Kiosk — Check Breaker cleanliness',
               'GSS-side VCB & Kiosk — Check Torqing of AC termination',
               'GSS-side VCB & Kiosk — Check bolt, washer and lug for heatup',
               'GSS-side VCB & Kiosk — Check Breaker Jointing Kit (Any Crack in Jointing Kit)',
               'GSS-side VCB & Kiosk — Check manual Spring charge and On/Off',
               'GSS-side VCB & Kiosk — Check operation of Breaker',
               'GSS-side VCB & Kiosk — Check the Indication Lamp',
               'GSS-side VCB & Kiosk — Check the Annunciator function',
               'GSS-side VCB & Kiosk — Check the Hooter function',
               'GSS-side VCB & Kiosk — Check the Function of Selector switch and TNC Switch and Push Button',
               'GSS-side VCB & Kiosk — Check door lock and door working',
               'GSS-side Switchyard — Bush Should be Clear',
               'GSS-side Switchyard — Oil Leakage Issue from CT & PT',
               'GSS-side Switchyard — Yard Fencing Should be Proper',
               'GSS-side Switchyard — Grease on Isolator Operating Part',
               'GSS-side Switchyard — Equipment Bushing Proper',
               'GSS-side Switchyard — Jointing Kits Proper',
               'GSS-side Switchyard — Check ERT Value, if required fill water in pits',
               'GSS-side Switchyard — No Chattering Sound Heard in Yard',
               'GSS-side Switchyard — Yard Greet Should be Proper',
               'GSS-side Switchyard — Fire Bucket Filled with Sand & Fire Extinguisher Filled',
               'GSS-side Switchyard — Check horngap Rod and Fuse Condition',
               'GSS-side Switchyard — Check the LA is Intact'],
 'Earth pit': ['Earthing system check- ERT and Watering of all Pits'],
 'Miscellaneous': ['Water pipe line and motor- Check for leakage and water preassure',
                   'Comminication system check- System online monitoring',
                   'WMS calibration checked- Check data as per Ambient Condition',
                   'Water Drainage System Check- Check for leakage']}

CHECKLISTS = {'Inverter': ['Check inverter cleanliness',
              'Check tourqing of AC Termination',
              'Check AC Cable Termination and Earthing Connections',
              'Check All cooling fans are working',
              'Check Cooling Fan Cleanliness',
              'Check Inverter Heat Sink Cleanliness',
              'String testig to be done - And Make String Report',
              'Check any abnormilities (Cable puncher,crack in cable insulation)',
              'Check/visually inspect the inverter-side MC4. Ensure all MC4 connectors are properly locked. '
              'Perform a string check to identify any cuts in the DC cable.',
              'Check Inverter Communication with RMS/COM100',
              'ERT of All DC Earthing Pits',
              'Check DC On/Off Switch',
              'Check Cable entry hole seald by PV Foam',
              'Check inverter stand and canopy',
              'Grass/bushes status below inverter',
              'Gravel condition in inverter area',
              'Check Inverter Error / Fault History',
              'Check AC and DC supply on condition after PM',
              'Module cleanning robot inspection',
              'Modules physical inspection- For any Damage',
              'MMS check ( rusting, wending nut bolts lossing)',
              'Cleaning of fan filter units'],
 'ACCB': ['Check ACCB cleanliness',
          'Check Bus Bar Sleeve',
          'Check Bus Bar Bolt, Lug, Washer for Heat Up & Looseness',
          'Check Fan is working',
          'Check Power cable lug',
          'Check ACCB fuse base',
          'Check Fuse base connection tightness',
          'Check Temp. in ACCB',
          'Check Fuse failure',
          'Check Acrylic sheet mounting',
          'Check Air filter & fan filter for cleanliness',
          'Check Cable dressing',
          'Check Door lock & Door working',
          'Check LED Indication',
          'Check for any unwanted opening or Hole',
          'Check Enclosure Rusting',
          'Check ACCB Rotary Switch is in ON condition',
          'Check main ACB/MCCB condition and operation (if installed)',
          'Check ACB/MCCB terminal connections (if installed)',
          'Check CT condition and secondary connections',
          'Check PT/VT and PT fuse condition (if installed)',
          'Check busbar alignment and electrical clearances',
          'Measure phase-wise voltage',
          'Measure phase-wise current',
          'Check energy meter and display',
          'Check protection relay and trip circuit (if installed)',
          'Thermal scan of busbars, fuse bases, breaker terminals and cable lugs',
          'Inspect MCBs, DPs, fuses, relays, and timers for abnormalities, burns, or overheating'],
 'IDT Transformer': ["Isolation, LOTO and permit to work for all 'Shutdown' items below",
                     'Clean Complete Body of transformer',
                     'Check Oil Leakage from Transformer ( Radiator,Conservator, Tank and Air Release & Oil '
                     'Releive Valve)',
                     'Check Torqing of LT and HT termmination',
                     'Check Tightness of marshelling box connection',
                     'Check tap changing take place both in Manual mode And Remote Mode',
                     'Check all the cable termination',
                     'Check OTI reading and alarm/trip indication (visual)',
                     'Check WTI reading and alarm/trip indication (visual)',
                     'Check Buchholz relay (visual)',
                     'Check MOG Alarm',
                     'Check and release Air Vent in Buholz relay',
                     'Check earthing connections of transformer (visual)',
                     'Visual check for any crack on Insulator',
                     'Check and remove Vegetation in the yard',
                     'Check Oil Level of transformer tank and OLTC',
                     'Check the Breather Silicagel condition',
                     'Noise and vibration',
                     'Pressure relief device (PRD/PRV) and discharge pipe (visual)',
                     'OLTC (visual): oil level, relay flag, breather, drive box',
                     'Radiators, valves and cooling',
                     'Marshalling box and drive box condition',
                     'Nameplate, diagram, tap chart and labels',
                     'Check IR Values of HT nad LT Winding',
                     'Check OTI Alarm and Trip',
                     'Check WTI Alarm and Trip',
                     'Check Buchholz alarm and Trip',
                     'Check Earth resistanse of Transformer Earthing'],
 'VCB': ['Isolation, LOTO, permit to work, earthing and voltage-free proving before any intrusive check',
         'Check Breaker cleanliness',
         'Check Torqing of AC termination',
         'Check bolt, washer and lug for heatup',
         'Check Breaker Jointing Kit (Any Crack in Jointing Kit)',
         'Check manual Spring charge and On/Off',
         'Check operation of Breaker',
         'Check the Indication Lamp',
         'Check the Annunciator function',
         'Check the Hooter function',
         'Check the Function of Selector switch and TNC Switch and Push Button',
         'Check door lock and door working',
         'Operation counter and spring charging time',
         'Mechanical and electrical interlocks',
         'Earth switch operation and status',
         'Trip and close coils, trip circuit supervision',
         'Control power: DC/AC auxiliary supply',
         'Space heater, thermostat, panel lighting, humidity',
         'Cable compartment and entry sealing',
         'Ventilation, arc vent and pressure-relief flap',
         'Panel earthing and bonding',
         'Safety items and labelling'],
 '4 Pole + ACDB + Aux. TX': ['Four Pole — Isolation, LOTO, permit to work and discharge/earthing for all '
                             "'Shutdown' items",
                             'Four Pole — Bush Should be Clear',
                             'Four Pole — Oil Leakage Issue from CT & PT',
                             'Four Pole — Yard Fencing Should be Proper',
                             'Four Pole — Grease on Isolator Operating Part',
                             'Four Pole — Equipment Bushing Proper',
                             'Four Pole — Jointing Kits Proper',
                             'Four Pole — Check ERT Value, if required fill water in pits',
                             'Four Pole — No Chattering Sound Heard in Yard',
                             'Four Pole — Yard Greet Should be Proper',
                             'Four Pole — Fire Bucket Filled with Sand & Fire Extinguisher Filled',
                             'Four Pole — Check horngap Rod and Fuse Condition',
                             'Four Pole — Check the LA is Intact',
                             'Four Pole — Isolators and earth switch - condition',
                             'Four Pole — Insulators (post, pin, string) condition',
                             'Four Pole — Dog conductor, jumpers, clamps and connectors',
                             'Four Pole — Visual inspection of the four-pole structure',
                             'Four Pole — Earthing strip and earthing connections',
                             'Four Pole — HT cable route, risers and terminations',
                             'Four Pole — Lightning protection (mast / shield wire, if provided)',
                             'Four Pole — Bird and animal protection',
                             'Four Pole — Yard lighting, emergency light and signage',
                             'Four Pole — Safety items and PPE',
                             'Four Pole — Drainage and monsoon readiness',
                             'ACDB — HT & LT Pannels Cleaning Record',
                             'ACDB — Inspect MCBs, DPs, fuses, relays, and timers for abnormalities, burns, '
                             'or overheating',
                             "Auxiliary Transformer — Isolation, LOTO and permit to work for all 'Shutdown' "
                             'items below',
                             'Auxiliary Transformer — Clean Complete Body of transformer',
                             'Auxiliary Transformer — Check Oil Leakage from Transformer ( '
                             'Radiator,Conservator, Tank and Air Release & Oil Releive Valve)',
                             'Auxiliary Transformer — Check Torqing of LT and HT termmination',
                             'Auxiliary Transformer — Check Tightness of marshelling box connection',
                             'Auxiliary Transformer — Check tap changing take place both in Manual mode And '
                             'Remote Mode',
                             'Auxiliary Transformer — Check all the cable termination',
                             'Auxiliary Transformer — Check OTI reading and alarm/trip indication (visual)',
                             'Auxiliary Transformer — Check WTI reading and alarm/trip indication (visual)',
                             'Auxiliary Transformer — Check Buchholz relay (visual)',
                             'Auxiliary Transformer — Check MOG Alarm',
                             'Auxiliary Transformer — Check and release Air Vent in Buholz relay',
                             'Auxiliary Transformer — Check earthing connections of transformer (visual)',
                             'Auxiliary Transformer — Visual check for any crack on Insulator',
                             'Auxiliary Transformer — Check and remove Vegetation in the yard',
                             'Auxiliary Transformer — Check Oil Level of transformer tank and OLTC',
                             'Auxiliary Transformer — Check the Breather Silicagel condition',
                             'Auxiliary Transformer — Noise and vibration',
                             'Auxiliary Transformer — Pressure relief device (PRD/PRV) and discharge pipe '
                             '(visual)',
                             'Auxiliary Transformer — OLTC (visual): oil level, relay flag, breather, drive '
                             'box',
                             'Auxiliary Transformer — Radiators, valves and cooling',
                             'Auxiliary Transformer — Marshalling box and drive box condition',
                             'Auxiliary Transformer — Nameplate, diagram, tap chart and labels',
                             'Auxiliary Transformer — Check IR Values of HT nad LT Winding',
                             'Auxiliary Transformer — Check OTI Alarm and Trip',
                             'Auxiliary Transformer — Check WTI Alarm and Trip',
                             'Auxiliary Transformer — Check Buchholz alarm and Trip',
                             'Auxiliary Transformer — Check Earth resistanse of Transformer Earthing'],
 'Transmission line': ['Patrol safety, PPE and permit for rectification',
                       'Check the insulator crackness from Ground',
                       'Check conductor Sag from Ground',
                       'Check and ensure the pole & Pin insulators are upright and free from slantinng from '
                       'Ground',
                       'Check and ensure poles are with out any damage/observation from Ground',
                       'Check and cut trees and shrubs during line clearance',
                       'Check conductors are properly seated in its slot from Ground',
                       'Check earth connection to the poles from Ground',
                       'Check the guard wire for properness from Ground',
                       'Check the stay insulator healthiness and stay wire properness',
                       'PCC pole base and foundation',
                       'Cross-arm and hardware',
                       'Pole/tower number, phase plates and danger board',
                       'Tower body and members',
                       'Tower foundation',
                       'Double circuit only (if applicable): circuit identification and clearances',
                       'Double circuit only (if applicable): shutdown and earthing readiness',
                       'Disc insulator strings and hardware (tower)',
                       'Jumpers, joints and clamps',
                       'Corridor encroachment and third-party activity',
                       'Crossings (road, rail, river, canal, other lines)',
                       'Terminal/cable-riser pole (overhead line to HT cable)',
                       'Anti-theft check',
                       'Electricty Theft',
                       'Check all jointing kits visually',
                       'Complete line patrolling from the plant to GSS',
                       'Check arcing horn for any carbon deposits'],
 'GSS visit': ['GSS-side VCB & Kiosk — Isolation, LOTO, permit to work, earthing and voltage-free proving '
               'before any intrusive check',
               'GSS-side VCB & Kiosk — Check Breaker cleanliness',
               'GSS-side VCB & Kiosk — Check Torqing of AC termination',
               'GSS-side VCB & Kiosk — Check bolt, washer and lug for heatup',
               'GSS-side VCB & Kiosk — Check Breaker Jointing Kit (Any Crack in Jointing Kit)',
               'GSS-side VCB & Kiosk — Check manual Spring charge and On/Off',
               'GSS-side VCB & Kiosk — Check operation of Breaker',
               'GSS-side VCB & Kiosk — Check the Indication Lamp',
               'GSS-side VCB & Kiosk — Check the Annunciator function',
               'GSS-side VCB & Kiosk — Check the Hooter function',
               'GSS-side VCB & Kiosk — Check the Function of Selector switch and TNC Switch and Push Button',
               'GSS-side VCB & Kiosk — Check door lock and door working',
               'GSS-side VCB & Kiosk — Operation counter and spring charging time',
               'GSS-side VCB & Kiosk — Mechanical and electrical interlocks',
               'GSS-side VCB & Kiosk — Earth switch operation and status',
               'GSS-side VCB & Kiosk — Trip and close coils, trip circuit supervision',
               'GSS-side VCB & Kiosk — Control power: DC/AC auxiliary supply',
               'GSS-side VCB & Kiosk — Space heater, thermostat, panel lighting, humidity',
               'GSS-side VCB & Kiosk — Cable compartment and entry sealing',
               'GSS-side VCB & Kiosk — Ventilation, arc vent and pressure-relief flap',
               'GSS-side VCB & Kiosk — Panel earthing and bonding',
               'GSS-side VCB & Kiosk — Safety items and labelling',
               'GSS-side Switchyard — Isolation, LOTO, permit to work and discharge/earthing for all '
               "'Shutdown' items",
               'GSS-side Switchyard — Bush Should be Clear',
               'GSS-side Switchyard — Oil Leakage Issue from CT & PT',
               'GSS-side Switchyard — Yard Fencing Should be Proper',
               'GSS-side Switchyard — Grease on Isolator Operating Part',
               'GSS-side Switchyard — Equipment Bushing Proper',
               'GSS-side Switchyard — Jointing Kits Proper',
               'GSS-side Switchyard — Check ERT Value, if required fill water in pits',
               'GSS-side Switchyard — No Chattering Sound Heard in Yard',
               'GSS-side Switchyard — Yard Greet Should be Proper',
               'GSS-side Switchyard — Fire Bucket Filled with Sand & Fire Extinguisher Filled',
               'GSS-side Switchyard — Check horngap Rod and Fuse Condition',
               'GSS-side Switchyard — Check the LA is Intact',
               'GSS-side Switchyard — Isolators and earth switch - condition',
               'GSS-side Switchyard — Insulators (post, pin, string) condition',
               'GSS-side Switchyard — Dog conductor, jumpers, clamps and connectors',
               'GSS-side Switchyard — I-beam / gantry structure and foundation',
               'GSS-side Switchyard — Earthing strip and earthing connections',
               'GSS-side Switchyard — HT cable route, risers and terminations',
               'GSS-side Switchyard — CT and PT outdoor MIP',
               'GSS-side Switchyard — CT and PT oil level',
               'GSS-side Switchyard — ABT meters',
               'GSS-side Switchyard — Lightning protection (mast / shield wire, if provided)',
               'GSS-side Switchyard — Bird and animal protection',
               'GSS-side Switchyard — Yard lighting, emergency light and signage',
               'GSS-side Switchyard — Safety items and PPE',
               'GSS-side Switchyard — Drainage and monsoon readiness'],
 'Earth pit': ['Earthing system check- ERT and Watering of all Pits'],
 'Miscellaneous': ['Water pipe line and motor- Check for leakage and water preassure',
                   'Comminication system check- System online monitoring',
                   'WMS calibration checked- Check data as per Ambient Condition',
                   'Water Drainage System Check- Check for leakage']}

GUIDANCE = {'Inverter': {'Check inverter cleanliness': {'description': 'Check inverter cleanliness',
                                             'parameters': 'Surface and vent cleanliness',
                                             'abnormalities': 'Dust accumulation, insect nests, debris',
                                             'corrective_actions': 'Clean using a dry cloth or blower. Avoid '
                                                                   'moisture; ensure no foreign objects inside.',
                                             'source_sheet': 'Inverter',
                                             'source_item': 1},
              'Check tourqing of AC Termination': {'description': 'Check tourqing of AC Termination',
                                                   'parameters': 'Torque values on AC terminals',
                                                   'abnormalities': 'Loose terminals, discoloration, arcing marks',
                                                   'corrective_actions': 'Retorque connections as per '
                                                                         "manufacturer's torque specs. Replace "
                                                                         'damaged lugs if any.',
                                                   'source_sheet': 'Inverter',
                                                   'source_item': 2},
              'Check AC Cable Termination and Earthing Connections': {'description': 'Check AC Cable Termination '
                                                                                     'and Earthing Connections',
                                                                      'parameters': 'AC cable lugs, earth '
                                                                                    'connections, terminal '
                                                                                    'condition and tightness',
                                                                      'abnormalities': 'Loose connections, '
                                                                                       'corrosion, overheating '
                                                                                       'and damaged lugs',
                                                                      'corrective_actions': 'Rectify connections '
                                                                                            'and replace damaged '
                                                                                            'lugs or cables',
                                                                      'source_sheet': 'Inverter',
                                                                      'source_item': 3},
              'Check All cooling fans are working': {'description': 'Check All cooling fans are working',
                                                     'parameters': 'Rotation, noise, airflow',
                                                     'abnormalities': 'Fan not spinning, unusual noise, overheat '
                                                                      'warning',
                                                     'corrective_actions': 'Contact Supplier if Fan not working.',
                                                     'source_sheet': 'Inverter',
                                                     'source_item': 4},
              'Check Cooling Fan Cleanliness': {'description': 'Check Cooling Fan Cleanliness',
                                                'parameters': 'Fan blades, fan guards and air intake/exhaust '
                                                              'vents',
                                                'abnormalities': 'Dust accumulation, clogged vents, debris or '
                                                                 'obstruction in airflow',
                                                'corrective_actions': 'Clean fan blades and guards using a dry '
                                                                      'cloth or compressed air as per OEM '
                                                                      'instructions. Ensure free airflow',
                                                'source_sheet': 'Inverter',
                                                'source_item': 5},
              'Check Inverter Heat Sink Cleanliness': {'description': 'Check Inverter Heat Sink Cleanliness',
                                                       'parameters': 'Heat sink fins and cooling channels',
                                                       'abnormalities': 'Dust accumulation, blocked fins, dirt '
                                                                        'deposition or restricted heat '
                                                                        'dissipation',
                                                       'corrective_actions': 'Clean heat sink fins using a soft '
                                                                             'brush or compressed air as per OEM '
                                                                             'instructions. Ensure proper heat '
                                                                             'dissipation.',
                                                       'source_sheet': 'Inverter',
                                                       'source_item': 6},
              'String testig to be done - And Make String Report': {'description': 'String testig to be done - '
                                                                                   'And Make String Report',
                                                                    'parameters': 'Voltage/current output per '
                                                                                  'string',
                                                                    'abnormalities': 'Uneven string voltages, low '
                                                                                     'current',
                                                                    'corrective_actions': 'Identify and Check the '
                                                                                          'odd String for any '
                                                                                          'abnormality. Record '
                                                                                          'data and submit a '
                                                                                          'detailed report.',
                                                                    'source_sheet': 'Inverter',
                                                                    'source_item': 7},
              'Check any abnormilities (Cable puncher,crack in cable insulation)': {'description': 'Check any '
                                                                                                   'abnormilities '
                                                                                                   '(Cable '
                                                                                                   'puncher,crack '
                                                                                                   'in cable '
                                                                                                   'insulation)',
                                                                                    'parameters': 'Physical '
                                                                                                  'inspection of '
                                                                                                  'cables',
                                                                                    'abnormalities': 'Cable '
                                                                                                     'puncture, '
                                                                                                     'insulation '
                                                                                                     'cracks, '
                                                                                                     'burn marks',
                                                                                    'corrective_actions': 'Replace '
                                                                                                          'damaged '
                                                                                                          'cables. '
                                                                                                          'Ensure '
                                                                                                          'proper '
                                                                                                          'routing '
                                                                                                          'and '
                                                                                                          'clamping '
                                                                                                          'of new '
                                                                                                          'cables.',
                                                                                    'source_sheet': 'Inverter',
                                                                                    'source_item': 8},
              'Check/visually inspect the inverter-side MC4. Ensure all MC4 connectors are properly locked. Perform a string check to identify any cuts in the DC cable.': {'description': 'Check '
                                                                                                                                                                                           'DC '
                                                                                                                                                                                           'Cable '
                                                                                                                                                                                           'Connectors '
                                                                                                                                                                                           '(MC4',
                                                                                                                                                                            'parameters': 'Connector '
                                                                                                                                                                                          'locking, '
                                                                                                                                                                                          'compatibility, '
                                                                                                                                                                                          'physical '
                                                                                                                                                                                          'condition '
                                                                                                                                                                                          'and '
                                                                                                                                                                                          'heating',
                                                                                                                                                                            'abnormalities': 'Loose '
                                                                                                                                                                                             'connectors, '
                                                                                                                                                                                             'cracks, '
                                                                                                                                                                                             'discoloration, '
                                                                                                                                                                                             'water '
                                                                                                                                                                                             'ingress '
                                                                                                                                                                                             'or '
                                                                                                                                                                                             'melting',
                                                                                                                                                                            'corrective_actions': 'Replace '
                                                                                                                                                                                                  'damaged '
                                                                                                                                                                                                  'connectors '
                                                                                                                                                                                                  'with '
                                                                                                                                                                                                  'compatible '
                                                                                                                                                                                                  'OEM-approved '
                                                                                                                                                                                                  'connectors '
                                                                                                                                                                                                  'and '
                                                                                                                                                                                                  'ensure '
                                                                                                                                                                                                  'proper '
                                                                                                                                                                                                  'crimping.',
                                                                                                                                                                            'source_sheet': 'Inverter',
                                                                                                                                                                            'source_item': 9},
              'Check Inverter Communication with RMS/COM100': {'description': 'Check Inverter Communication with '
                                                                              'RMS',
                                                               'parameters': 'Check Data on portal',
                                                               'abnormalities': 'Inverter/Equipment Offline',
                                                               'corrective_actions': 'Check Communication Cable '
                                                                                     'and Communication Card- '
                                                                                     'Contact Supplier if any '
                                                                                     'communication card/ Logger '
                                                                                     'Burnig Found',
                                                               'source_sheet': 'Inverter',
                                                               'source_item': 10},
              'ERT of All DC Earthing Pits': {'description': 'ERT of All DC Earthing Pits',
                                              'parameters': 'ERT Values',
                                              'abnormalities': 'High Resistance Value more than 2 Ohm',
                                              'corrective_actions': 'Earthing Strip Connection need to Check, '
                                                                    'Watering with Salt Water if Requried',
                                              'source_sheet': 'Inverter',
                                              'source_item': 11},
              'Check DC On/Off Switch': {'description': 'Check DC On/Off Switch',
                                         'parameters': 'Smooth operation, ON/OFF functionality',
                                         'abnormalities': 'Jammed switch, not turning on/off, arcing inside',
                                         'corrective_actions': 'Contact Supplier in case of any Abnormality of DC '
                                                               'Switch Functioning',
                                         'source_sheet': 'Inverter',
                                         'source_item': 12},
              'Check Cable entry hole seald by PV Foam': {'description': 'Check Cable entry hole seald by PV Foam',
                                                          'parameters': 'Foam condition and coverage',
                                                          'abnormalities': 'Gaps around cable entry, water/dust '
                                                                           'ingress',
                                                          'corrective_actions': 'Reseal with appropriate PV foam. '
                                                                                'Prevent entry of moisture or '
                                                                                'vermin.',
                                                          'source_sheet': 'Inverter',
                                                          'source_item': 13},
              'Check inverter stand and canopy': {'description': 'Check inverter stand and canopy',
                                                  'parameters': 'Strength, Rusting, hardware, stand foundation',
                                                  'abnormalities': 'rust on the stand and canopy, hardware loose, '
                                                                   'stand foundation damage or tilt, canopy '
                                                                   'hardware tightness',
                                                  'corrective_actions': 'Spray on rusted parts, hardware '
                                                                        'tightness, foundation repairing',
                                                  'source_sheet': 'Inverter',
                                                  'source_item': 14},
              'Grass/bushes status below inverter': {'description': 'Grass/bushes status below inverter',
                                                     'parameters': 'need to check grass/bushes or any trash',
                                                     'abnormalities': 'Grass/bushes/trash available in inverter '
                                                                      'area',
                                                     'corrective_actions': 'Need to remove bushes/grass/trash '
                                                                           'underneath inverter',
                                                     'source_sheet': 'Inverter',
                                                     'source_item': 15},
              'Gravel condition in inverter area': {'description': 'Gravel condition in inverter area',
                                                    'parameters': 'need to have sufficent gravel in inverter area',
                                                    'abnormalities': 'need to have 300 MM depth of gravel',
                                                    'corrective_actions': 'If the quantity is not sufficent, need '
                                                                          'to add gravel in inverter area to '
                                                                          'avoid vegetaion underneath inverter',
                                                    'source_sheet': 'Inverter',
                                                    'source_item': 16},
              'Check Inverter Error / Fault History': {'description': 'Check Inverter Error / Fault History',
                                                       'parameters': 'Fault logs, warning history and inverter '
                                                                     'trip records',
                                                       'abnormalities': 'Repeated grid faults, insulation faults, '
                                                                        'overtemperature and DC faults',
                                                       'corrective_actions': 'Investigate recurring faults and '
                                                                             'coordinate with HO team and  OEM if '
                                                                             'required',
                                                       'source_sheet': 'Inverter',
                                                       'source_item': 17},
              'Check AC and DC supply on condition after PM': {'description': 'Check AC and DC supply on '
                                                                              'condition after PM',
                                                               'parameters': 'All DC switch ON and MCCB ON (AC '
                                                                             'supply)',
                                                               'abnormalities': 'All DC switch and MCCB should be '
                                                                                'in ON condition after PM',
                                                               'corrective_actions': 'If any issue is found, need '
                                                                                     'to contact HO team or OEM '
                                                                                     'for further rectification',
                                                               'source_sheet': 'Inverter',
                                                               'source_item': 18}},
 'ACCB': {'Check ACCB cleanliness': {'description': 'Check ACCB cleanliness',
                                     'parameters': 'Dust, debris, moisture, ventilation clearance',
                                     'abnormalities': 'Excessive dust, moisture, foreign objects',
                                     'corrective_actions': 'Clean using a dry cloth or suitable vacuum/air '
                                                           'blower. Avoid directing debris into electrical '
                                                           'components.',
                                     'source_sheet': 'ACCB',
                                     'source_item': 1},
          'Check Bus Bar Sleeve': {'description': 'Check busbar sleeves / insulation',
                                   'parameters': 'Insulation condition, coverage, cracks and clearances',
                                   'abnormalities': 'Brittle/cracked sleeves, burn marks, exposed busbar',
                                   'corrective_actions': 'Replace damaged insulation and verify clearances as per '
                                                         'approved design/OEM requirements.',
                                   'source_sheet': 'ACCB',
                                   'source_item': 2},
          'Check Bus Bar Bolt, Lug, Washer for Heat Up & Looseness': {'description': 'Check busbar bolts, lugs, '
                                                                                     'washers and joints',
                                                                      'parameters': 'Tightness, corrosion, '
                                                                                    'contact condition and '
                                                                                    'temperature',
                                                                      'abnormalities': 'Loose/missing hardware, '
                                                                                       'corrosion, discoloration, '
                                                                                       'abnormal heating',
                                                                      'corrective_actions': 'After isolation, '
                                                                                            'inspect and tighten '
                                                                                            'to OEM torque '
                                                                                            'values; replace '
                                                                                            'damaged '
                                                                                            'hardware/components.',
                                                                      'source_sheet': 'ACCB',
                                                                      'source_item': 3},
          'Check Fan is working': {'description': 'Check cooling fan operation',
                                   'parameters': 'Fan rotation, airflow, noise and operation',
                                   'abnormalities': 'Fan not running, slow rotation, unusual noise, low airflow',
                                   'corrective_actions': 'Clean or replace defective fan; verify supply and '
                                                         'control circuit.',
                                   'source_sheet': 'ACCB',
                                   'source_item': 4},
          'Check Power cable lug': {'description': 'Check power cable lugs and terminations',
                                    'parameters': 'Lug condition, crimping, insulation, tightness and '
                                                  'discoloration',
                                    'abnormalities': 'Loose/burnt lugs, damaged insulation, corrosion, '
                                                     'overheating',
                                    'corrective_actions': 'After isolation, rectify termination and replace '
                                                          'damaged lugs/cables using approved materials.',
                                    'source_sheet': 'ACCB',
                                    'source_item': 5},
          'Check ACCB fuse base': {'description': 'Check fuse base and fuse-holder condition',
                                   'parameters': 'Physical condition, secure mounting, contact condition',
                                   'abnormalities': 'Cracked/melted base, burnt or pitted contacts, loose '
                                                    'mounting',
                                   'corrective_actions': 'Replace damaged fuse base/holder and inspect the '
                                                         'associated fuse and connections.',
                                   'source_sheet': 'ACCB',
                                   'source_item': 6},
          'Check Fuse base connection tightness': {'description': 'Check fuse-holder connection tightness',
                                                   'parameters': 'Terminal condition and torque as per OEM '
                                                                 'specification',
                                                   'abnormalities': 'Loose screws, discoloration, arcing or '
                                                                    'heating',
                                                   'corrective_actions': 'After isolation, clean/replace damaged '
                                                                         'contacts and tighten to OEM torque '
                                                                         'specification.',
                                                   'source_sheet': 'ACCB',
                                                   'source_item': 7},
          'Check Temp. in ACCB': {'description': 'Check temperature inside ACCB',
                                  'parameters': 'Ambient and internal temperature; compare with equipment/OEM '
                                                'limits',
                                  'abnormalities': 'Abnormal temperature rise, hotspots, thermal alarm or '
                                                   'derating',
                                  'corrective_actions': 'Check loading, ventilation, fan/filter condition and '
                                                        'connections; investigate cause. Do not use 55°C as a '
                                                        'universal limit.',
                                  'source_sheet': 'ACCB',
                                  'source_item': 8},
          'Check Fuse failure': {'description': 'Check fuse condition and failure history',
                                 'parameters': 'Fuse rating/type, continuity when safely isolated, physical '
                                               'condition',
                                 'abnormalities': 'Blown fuse, discoloration, repeated fuse failure',
                                 'corrective_actions': 'Replace only with same approved type and rating after '
                                                       'identifying and rectifying the cause of failure.',
                                 'source_sheet': 'ACCB',
                                 'source_item': 9},
          'Check Acrylic sheet mounting': {'description': 'Check acrylic safety sheet mounting',
                                           'parameters': 'Secure mounting, cracks, coverage and protection from '
                                                         'accidental contact',
                                           'abnormalities': 'Loose screws, cracked/missing sheet, exposed live '
                                                            'parts',
                                           'corrective_actions': 'Secure or replace sheet; maintain designed '
                                                                 'clearances and barriers.',
                                           'source_sheet': 'ACCB',
                                           'source_item': 10},
          'Check Air filter & fan filter for cleanliness': {'description': 'Check air filter and fan filter '
                                                                           'cleanliness',
                                                            'parameters': 'Dust accumulation, filter condition '
                                                                          'and airflow',
                                                            'abnormalities': 'Clogged, damaged or missing '
                                                                             'filters; restricted airflow',
                                                            'corrective_actions': 'Clean or replace filters as '
                                                                                  'per OEM instructions.',
                                                            'source_sheet': 'ACCB',
                                                            'source_item': 11},
          'Check Cable dressing': {'description': 'Check cable dressing and supports',
                                   'parameters': 'Routing, bend radius, segregation, support and abrasion '
                                                 'protection',
                                   'abnormalities': 'Loose/messy cables, sharp bends, exposed conductors, '
                                                    'unsupported cables',
                                   'corrective_actions': 'Re-route and secure cables; replace damaged insulation '
                                                         'and maintain required segregation.',
                                   'source_sheet': 'ACCB',
                                   'source_item': 12},
          'Check Door lock & Door working': {'description': 'Check door, hinges, gasket and locking arrangement',
                                             'parameters': 'Door alignment, hinges, gasket/seal and lock '
                                                           'operation',
                                             'abnormalities': 'Misalignment, damaged gasket, loose hinges or '
                                                              'faulty lock',
                                             'corrective_actions': 'Adjust/repair hinges and lock; replace '
                                                                   'damaged gasket to maintain enclosure IP '
                                                                   'protection.',
                                             'source_sheet': 'ACCB',
                                             'source_item': 13},
          'Check LED Indication': {'description': 'Check LED indications',
                                   'parameters': 'Phase/healthy/trip indications, auxiliary supply and indication '
                                                 'wiring',
                                   'abnormalities': 'LED not working, incorrect or missing phase indication',
                                   'corrective_actions': 'Check auxiliary/PT supply, fuses, wiring and LED; '
                                                         'rectify or replace defective parts.',
                                   'source_sheet': 'ACCB',
                                   'source_item': 14},
          'Check for any unwanted opening or Hole': {'description': 'Check cable entry openings and gland sealing',
                                                     'parameters': 'Cable glands, unused openings, PU '
                                                                   'foam/sealing and ingress protection',
                                                     'abnormalities': 'Missing glands, open holes, water/dust '
                                                                      'ingress, rodent/insect entry',
                                                     'corrective_actions': 'Fit suitable cable glands and '
                                                                           'approved sealing material; maintain '
                                                                           'enclosure IP rating.',
                                                     'source_sheet': 'ACCB',
                                                     'source_item': 15},
          'Check Enclosure Rusting': {'description': 'Check enclosure rusting and corrosion',
                                      'parameters': 'Body, base, hinges, fasteners and coating',
                                      'abnormalities': 'Rust, oxidation, paint damage or corrosion',
                                      'corrective_actions': 'Remove corrosion safely and apply suitable '
                                                            'anti-corrosion primer/paint; replace weakened parts.',
                                      'source_sheet': 'ACCB',
                                      'source_item': 16},
          'Check ACCB Rotary Switch is in ON condition': {'description': 'Check rotary isolator/switch condition '
                                                                         'and position',
                                                          'parameters': 'ON/OFF indication, mechanical condition, '
                                                                        'terminals and interlock (if provided)',
                                                          'abnormalities': 'Jamming, damaged handle, loose '
                                                                           'terminals, abnormal heating or '
                                                                           'mismatch of indication',
                                                          'corrective_actions': 'Inspect and rectify under '
                                                                                'isolation; operate only within '
                                                                                'device rating and approved '
                                                                                'procedure.',
                                                          'source_sheet': 'ACCB',
                                                          'source_item': 17},
          'Check main ACB/MCCB condition and operation (if installed)': {'description': 'Check main ACB/MCCB '
                                                                                        'condition and operation '
                                                                                        '(if installed)',
                                                                         'parameters': 'Breaker rating, physical '
                                                                                       'condition, ON/OFF/trip '
                                                                                       'indication, mechanism and '
                                                                                       'service history',
                                                                         'abnormalities': 'Frequent trips, '
                                                                                          'jamming, damaged '
                                                                                          'mechanism, burn marks '
                                                                                          'or abnormal noise',
                                                                         'corrective_actions': 'Investigate trip '
                                                                                               'cause; arrange '
                                                                                               'authorized '
                                                                                               'breaker '
                                                                                               'inspection/testing '
                                                                                               'and repair.',
                                                                         'source_sheet': 'ACCB',
                                                                         'source_item': 18},
          'Check ACB/MCCB terminal connections (if installed)': {'description': 'Check ACB/MCCB terminal '
                                                                                'connections (if installed)',
                                                                 'parameters': 'Incoming/outgoing terminals, '
                                                                               'contact condition and torque',
                                                                 'abnormalities': 'Loose/burnt terminals, '
                                                                                  'discoloration, abnormal '
                                                                                  'heating',
                                                                 'corrective_actions': 'After isolation, inspect '
                                                                                       'and tighten to OEM '
                                                                                       'torque; replace damaged '
                                                                                       'parts.',
                                                                 'source_sheet': 'ACCB',
                                                                 'source_item': 19},
          'Check CT condition and secondary connections': {'description': 'Check CT condition and secondary '
                                                                          'connections',
                                                           'parameters': 'CT body, ratio/label, polarity '
                                                                         'markings, wiring and terminal tightness',
                                                           'abnormalities': 'Cracked/damaged CT, loose wiring, '
                                                                            'incorrect readings or overheating',
                                                           'corrective_actions': 'Rectify through qualified '
                                                                                 'personnel. Never open-circuit '
                                                                                 'an energized CT secondary; use '
                                                                                 'approved shorting procedure.',
                                                           'source_sheet': 'ACCB',
                                                           'source_item': 20},
          'Check PT/VT and PT fuse condition (if installed)': {'description': 'Check PT/VT and PT fuse condition '
                                                                              '(if installed)',
                                                               'parameters': 'PT/VT condition, fuse rating, '
                                                                             'wiring and voltage indication',
                                                               'abnormalities': 'Blown fuse, abnormal voltage '
                                                                                'indication, loose/damaged wiring',
                                                               'corrective_actions': 'Replace fuse with specified '
                                                                                     'rating after investigating '
                                                                                     'cause; rectify wiring/PT '
                                                                                     'fault.',
                                                               'source_sheet': 'ACCB',
                                                               'source_item': 21},
          'Check busbar alignment and electrical clearances': {'description': 'Check busbar alignment and '
                                                                              'electrical clearances',
                                                               'parameters': 'Phase-to-phase and phase-to-earth '
                                                                             'clearances, supports and barriers',
                                                               'abnormalities': 'Deformation, inadequate '
                                                                                'clearance, tracking/flashover '
                                                                                'marks or damaged supports',
                                                               'corrective_actions': 'Rectify as per approved '
                                                                                     'design and OEM '
                                                                                     'requirements; replace '
                                                                                     'damaged '
                                                                                     'supports/insulation.',
                                                               'source_sheet': 'ACCB',
                                                               'source_item': 22},
          'Measure phase-wise voltage': {'description': 'Measure phase-wise voltage',
                                         'parameters': 'R-Y, Y-B, B-R and phase-to-neutral values where '
                                                       'applicable',
                                         'abnormalities': 'Missing phase, abnormal voltage or voltage imbalance '
                                                          'beyond project limits',
                                         'corrective_actions': 'Verify meter readings and investigate upstream '
                                                               'supply, PT circuit and connections.',
                                         'source_sheet': 'ACCB',
                                         'source_item': 23},
          'Measure phase-wise current': {'description': 'Measure phase-wise current',
                                         'parameters': 'R, Y, B current under recorded operating load',
                                         'abnormalities': 'Abnormal phase imbalance, overload or unexpectedly '
                                                          'low/high current',
                                         'corrective_actions': 'Check inverter loading, phase distribution, CT '
                                                               'ratio/configuration and downstream conditions.',
                                         'source_sheet': 'ACCB',
                                         'source_item': 24},
          'Check energy meter and display': {'description': 'Check energy meter and display',
                                             'parameters': 'Voltage, current, kW, kVA, power factor, kWh and '
                                                           'phase data',
                                             'abnormalities': 'Blank display, missing phase data, implausible '
                                                              'readings or communication failure',
                                             'corrective_actions': 'Check auxiliary supply, CT/PT circuits, '
                                                                   'wiring, meter configuration and replace '
                                                                   'faulty meter if required.',
                                             'source_sheet': 'ACCB',
                                             'source_item': 25},
          'Check protection relay and trip circuit (if installed)': {'description': 'Check protection relay and '
                                                                                    'trip circuit (if installed)',
                                                                     'parameters': 'Relay health, settings '
                                                                                   'reference, alarms, trip '
                                                                                   'supply and trip-circuit '
                                                                                   'supervision',
                                                                     'abnormalities': 'Relay alarm/failure, trip '
                                                                                      'circuit unhealthy, '
                                                                                      'unexplained trips',
                                                                     'corrective_actions': 'Refer to approved '
                                                                                           'protection settings; '
                                                                                           'arrange testing by '
                                                                                           'qualified protection '
                                                                                           'engineer. Do not '
                                                                                           'alter settings '
                                                                                           'without '
                                                                                           'authorization.',
                                                                     'source_sheet': 'ACCB',
                                                                     'source_item': 26},
          'Thermal scan of busbars, fuse bases, breaker terminals and cable lugs': {'description': 'Thermal scan '
                                                                                                   'of busbars, '
                                                                                                   'fuse bases, '
                                                                                                   'breaker '
                                                                                                   'terminals and '
                                                                                                   'cable lugs',
                                                                                    'parameters': 'Phase-wise '
                                                                                                  'temperatures, '
                                                                                                  'load at time '
                                                                                                  'of scan, '
                                                                                                  'ambient '
                                                                                                  'temperature '
                                                                                                  'and hotspots',
                                                                                    'abnormalities': 'Abnormal '
                                                                                                     'temperature '
                                                                                                     'rise or '
                                                                                                     'significant '
                                                                                                     'phase-to-phase '
                                                                                                     'temperature '
                                                                                                     'difference',
                                                                                    'corrective_actions': 'Investigate '
                                                                                                          'load '
                                                                                                          'and '
                                                                                                          'connection '
                                                                                                          'condition; '
                                                                                                          'isolate '
                                                                                                          'before '
                                                                                                          'corrective '
                                                                                                          'work. '
                                                                                                          'Record '
                                                                                                          'thermograms '
                                                                                                          'and '
                                                                                                          'readings.',
                                                                                    'source_sheet': 'ACCB',
                                                                                    'source_item': 27}},
 'IDT Transformer': {"Isolation, LOTO and permit to work for all 'Shutdown' items below": {'description': 'Isolation, '
                                                                                                          'LOTO '
                                                                                                          'and '
                                                                                                          'permit '
                                                                                                          'to '
                                                                                                          'work '
                                                                                                          'for '
                                                                                                          'all '
                                                                                                          "'Shutdown' "
                                                                                                          'items '
                                                                                                          'below',
                                                                                           'parameters': 'HV and '
                                                                                                         'LV '
                                                                                                         'sides '
                                                                                                         'both '
                                                                                                         'isolated '
                                                                                                         '(including '
                                                                                                         'inverter/AC '
                                                                                                         'back-feed), '
                                                                                                         'proved '
                                                                                                         'dead, '
                                                                                                         'earthed, '
                                                                                                         'LOTO '
                                                                                                         'tags '
                                                                                                         'and PTW '
                                                                                                         'in '
                                                                                                         'place, '
                                                                                                         'HT '
                                                                                                         'gloves/PPE '
                                                                                                         'valid. '
                                                                                                         'For '
                                                                                                         "'Online' "
                                                                                                         'items '
                                                                                                         'keep '
                                                                                                         'safe '
                                                                                                         'distance '
                                                                                                         'and '
                                                                                                         'wear '
                                                                                                         'PPE',
                                                                                           'abnormalities': 'Work '
                                                                                                            'started '
                                                                                                            'without '
                                                                                                            'proof '
                                                                                                            'of '
                                                                                                            'dead',
                                                                                           'corrective_actions': 'Stop '
                                                                                                                 'work. '
                                                                                                                 'Complete '
                                                                                                                 'isolation '
                                                                                                                 'per '
                                                                                                                 'site '
                                                                                                                 'SOP '
                                                                                                                 'and '
                                                                                                                 'CEA '
                                                                                                                 'safety '
                                                                                                                 'regulations '
                                                                                                                 'first.',
                                                                                           'source_sheet': 'IDT',
                                                                                           'source_item': 1},
                     'Clean Complete Body of transformer': {'description': 'Clean complete body of transformer',
                                                            'parameters': 'Dust, rust, bird nests, oil stains on '
                                                                          'tank, radiators, bushings, marshalling '
                                                                          'box',
                                                            'abnormalities': 'Dirty surface, rust patches, nests',
                                                            'corrective_actions': 'Clean with dry cloth. Use '
                                                                                  'power washer only with '
                                                                                  'transformer isolated and '
                                                                                  'marshalling box, bushings and '
                                                                                  'OLTC covers sealed. Paint '
                                                                                  'rusted areas with OEM-approved '
                                                                                  'paint.',
                                                            'source_sheet': 'IDT',
                                                            'source_item': 2},
                     'Check Oil Leakage from Transformer ( Radiator,Conservator, Tank and Air Release & Oil Releive Valve)': {'description': 'Check '
                                                                                                                                             'oil '
                                                                                                                                             'leakage '
                                                                                                                                             'from '
                                                                                                                                             'transformer '
                                                                                                                                             '(radiator, '
                                                                                                                                             'conservator, '
                                                                                                                                             'tank, '
                                                                                                                                             'air '
                                                                                                                                             'release '
                                                                                                                                             'and '
                                                                                                                                             'oil '
                                                                                                                                             'relief '
                                                                                                                                             'valve)',
                                                                                                                              'parameters': 'Visual '
                                                                                                                                            'check '
                                                                                                                                            'for '
                                                                                                                                            'drips/stains '
                                                                                                                                            'at '
                                                                                                                                            'gaskets, '
                                                                                                                                            'welds, '
                                                                                                                                            'radiator '
                                                                                                                                            'flanges, '
                                                                                                                                            'drain/sampling '
                                                                                                                                            'valves, '
                                                                                                                                            'bushing '
                                                                                                                                            'base, '
                                                                                                                                            'Buchholz, '
                                                                                                                                            'PRD '
                                                                                                                                            'and '
                                                                                                                                            'OLTC',
                                                                                                                              'abnormalities': 'Oil '
                                                                                                                                               'stains, '
                                                                                                                                               'wet '
                                                                                                                                               'surfaces, '
                                                                                                                                               'puddles, '
                                                                                                                                               'oil '
                                                                                                                                               'in '
                                                                                                                                               'soak '
                                                                                                                                               'pit',
                                                                                                                              'corrective_actions': 'Locate '
                                                                                                                                                    'leak '
                                                                                                                                                    'source '
                                                                                                                                                    'and '
                                                                                                                                                    'reseal/replace '
                                                                                                                                                    'gasket '
                                                                                                                                                    'or '
                                                                                                                                                    'valve. '
                                                                                                                                                    'Contact '
                                                                                                                                                    'supplier '
                                                                                                                                                    'before '
                                                                                                                                                    'any '
                                                                                                                                                    'work '
                                                                                                                                                    '(warranty).',
                                                                                                                              'source_sheet': 'IDT',
                                                                                                                              'source_item': 3},
                     'Check Torqing of LT and HT termmination': {'description': 'Check torquing of LT and HT '
                                                                                'terminations',
                                                                 'parameters': 'Tightness per OEM torque using '
                                                                               'calibrated wrench; hold the '
                                                                               'bushing stem with a second '
                                                                               'spanner on brass bolts; '
                                                                               'torque-paint witness marks '
                                                                               'intact; LV lugs/busbars (high '
                                                                               'current)',
                                                                 'abnormalities': 'Loose ends, heating signs, '
                                                                                  'discoloration, broken witness '
                                                                                  'marks',
                                                                 'corrective_actions': 'Retorque to specified '
                                                                                       'values. Replace '
                                                                                       'overheated lugs. Work '
                                                                                       'very carefully on brass '
                                                                                       'bolts (do not '
                                                                                       'overtighten).',
                                                                 'source_sheet': 'IDT',
                                                                 'source_item': 4},
                     'Check Tightness of marshelling box connection': {'description': 'Check tightness of '
                                                                                      'marshalling box '
                                                                                      'connections',
                                                                       'parameters': 'Terminal blocks and wiring, '
                                                                                     'ferrules, CT shorting '
                                                                                     'links, heater and lamp '
                                                                                     'working, door gasket',
                                                                       'abnormalities': 'Loose terminals, '
                                                                                        'sparking/burn marks, '
                                                                                        'moisture',
                                                                       'corrective_actions': 'Tighten or '
                                                                                             'reterminate loose '
                                                                                             'connections; '
                                                                                             'replace '
                                                                                             'heater/gasket.',
                                                                       'source_sheet': 'IDT',
                                                                       'source_item': 5},
                     'Check tap changing take place both in Manual mode And Remote Mode': {'description': 'Check '
                                                                                                          'tap '
                                                                                                          'changing '
                                                                                                          'in '
                                                                                                          'manual '
                                                                                                          'and '
                                                                                                          'remote '
                                                                                                          'mode '
                                                                                                          '(OLTC)',
                                                                                           'parameters': 'Raise/lower '
                                                                                                         'one '
                                                                                                         'step in '
                                                                                                         'manual '
                                                                                                         'and '
                                                                                                         'remote '
                                                                                                         'at low '
                                                                                                         'load; '
                                                                                                         'tap '
                                                                                                         'position '
                                                                                                         'indicator '
                                                                                                         'vs '
                                                                                                         'SCADA '
                                                                                                         'vs '
                                                                                                         'mechanical; '
                                                                                                         'step '
                                                                                                         'complete; '
                                                                                                         'counter '
                                                                                                         'reading',
                                                                                           'abnormalities': 'Unresponsive '
                                                                                                            'tap '
                                                                                                            'change, '
                                                                                                            'mismatch '
                                                                                                            'in '
                                                                                                            'SCADA, '
                                                                                                            'out-of-step, '
                                                                                                            'noise',
                                                                                           'corrective_actions': 'Check '
                                                                                                                 'OLTC '
                                                                                                                 'motor '
                                                                                                                 'MCB '
                                                                                                                 'and '
                                                                                                                 'control '
                                                                                                                 'supply; '
                                                                                                                 'if '
                                                                                                                 'still '
                                                                                                                 'not '
                                                                                                                 'working '
                                                                                                                 'contact '
                                                                                                                 'supplier. '
                                                                                                                 'Do '
                                                                                                                 'not '
                                                                                                                 'operate '
                                                                                                                 'beyond '
                                                                                                                 'end '
                                                                                                                 'limits.',
                                                                                           'source_sheet': 'IDT',
                                                                                           'source_item': 6},
                     'Check all the cable termination': {'description': 'Check all the cable terminations',
                                                         'parameters': 'HV/LV cable ends, cable box and bushing '
                                                                       'connections, gland/armour earthing, '
                                                                       'heat-shrink/boot integrity',
                                                         'abnormalities': 'Fraying, heat signs, damaged '
                                                                          'insulation, tracking, moisture',
                                                         'corrective_actions': 'Re-terminate or replace cables.',
                                                         'source_sheet': 'IDT',
                                                         'source_item': 7},
                     'Check OTI reading and alarm/trip indication (visual)': {'description': 'Check OTI reading '
                                                                                             'and alarm/trip '
                                                                                             'indication (visual)',
                                                                              'parameters': 'OTI reading vs '
                                                                                            'ambient and last '
                                                                                            'month; alarm/trip '
                                                                                            'pointers at set '
                                                                                            'values; max-pointer; '
                                                                                            'no alarm/trip flag. '
                                                                                            'Trip testing is done '
                                                                                            'in the Yearly Checks',
                                                                              'abnormalities': 'Reading unusually '
                                                                                               'high, gauge '
                                                                                               'stuck, alarm flag',
                                                                              'corrective_actions': 'Contact '
                                                                                                    'supplier.',
                                                                              'source_sheet': 'IDT',
                                                                              'source_item': 8},
                     'Check WTI reading and alarm/trip indication (visual)': {'description': 'Check WTI reading '
                                                                                             'and alarm/trip '
                                                                                             'indication (visual)',
                                                                              'parameters': 'WTI reading vs OTI '
                                                                                            'and load; alarm/trip '
                                                                                            'pointers at set '
                                                                                            'values. Trip testing '
                                                                                            'is done in the '
                                                                                            'Yearly Checks',
                                                                              'abnormalities': 'Reading far from '
                                                                                               'OTI, gauge stuck, '
                                                                                               'alarm flag',
                                                                              'corrective_actions': 'Contact '
                                                                                                    'supplier.',
                                                                              'source_sheet': 'IDT',
                                                                              'source_item': 9},
                     'Check Buchholz relay (visual)': {'description': 'Check Buchholz relay (visual)',
                                                       'parameters': 'Relay full of oil, no gas in the window, '
                                                                     'test valve closed, wiring box sealed. '
                                                                     'Alarm/trip testing is done in the Yearly '
                                                                     'Checks',
                                                       'abnormalities': 'Gas accumulation, relay not full, '
                                                                        'moisture in box',
                                                       'corrective_actions': 'Contact supplier. If gas is present '
                                                                             'record quantity/colour (see next '
                                                                             'item).',
                                                       'source_sheet': 'IDT',
                                                       'source_item': 10},
                     'Check MOG Alarm': {'description': 'Check MOG alarm and level indication',
                                         'parameters': 'Magnetic oil gauge level vs oil-temperature curve; '
                                                       'pointer free movement; no low-level alarm flag',
                                         'abnormalities': 'Low level, stuck pointer, low-level alarm',
                                         'corrective_actions': 'Contact supplier.',
                                         'source_sheet': 'IDT',
                                         'source_item': 11},
                     'Check and release Air Vent in Buholz relay': {'description': 'Check and release air vent in '
                                                                                   'Buchholz relay',
                                                                    'parameters': 'Check venting; if gas is '
                                                                                  'present, record volume/colour '
                                                                                  'before releasing and note for '
                                                                                  'DGA sampling at yearly check',
                                                                    'abnormalities': 'Airlock inside relay, '
                                                                                     'repeated gas collection',
                                                                    'corrective_actions': 'Release air manually '
                                                                                          'via vent valve. '
                                                                                          'Repeated gas means '
                                                                                          'inform supplier and do '
                                                                                          'DGA earlier.',
                                                                    'source_sheet': 'IDT',
                                                                    'source_item': 12},
                     'Check earthing connections of transformer (visual)': {'description': 'Check earthing '
                                                                                           'connections of '
                                                                                           'transformer (visual)',
                                                                            'parameters': 'Body, neutral and '
                                                                                          'arrester earth strips '
                                                                                          'tight, no '
                                                                                          'corrosion/damage, '
                                                                                          'earth pit cover and '
                                                                                          'chamber condition. '
                                                                                          'Earth resistance '
                                                                                          'measurement is done in '
                                                                                          'the Yearly Checks',
                                                                            'abnormalities': 'Loose or corroded '
                                                                                             'strip, broken link, '
                                                                                             'damaged earth pit '
                                                                                             'cover',
                                                                            'corrective_actions': 'Tighten or '
                                                                                                  'replace '
                                                                                                  'strips; repair '
                                                                                                  'earth pit. '
                                                                                                  'Watering/salt '
                                                                                                  'is a temporary '
                                                                                                  'measure only; '
                                                                                                  'salt corrodes '
                                                                                                  'the electrode.',
                                                                            'source_sheet': 'IDT',
                                                                            'source_item': 13},
                     'Visual check for any crack on Insulator': {'description': 'Visual check for any crack on '
                                                                                'insulators and bushings',
                                                                 'parameters': 'Cracks, chipping, flashover and '
                                                                               'tracking marks, '
                                                                               'dust/bird-dropping deposit, '
                                                                               'bushing oil level (if sight '
                                                                               'glass), arcing horn gap',
                                                                 'abnormalities': 'Cracks, chipping, flashover '
                                                                                  'marks, oil seepage',
                                                                 'corrective_actions': 'Contact supplier for '
                                                                                       'replacement. Clean '
                                                                                       'dust/deposit with dry '
                                                                                       'cloth under shutdown.',
                                                                 'source_sheet': 'IDT',
                                                                 'source_item': 14},
                     'Check and remove Vegetation in the yard': {'description': 'Check and remove vegetation in '
                                                                                'the yard',
                                                                 'parameters': 'Grass, weeds, bushes in yard, '
                                                                               'fence, around transformer, soak '
                                                                               'pit and gravel bed',
                                                                 'abnormalities': 'Plant growth near equipment, '
                                                                                  'fire hazard',
                                                                 'corrective_actions': 'Clear all vegetation near '
                                                                                       'electrical areas. Keep '
                                                                                       'gravel layer clean.',
                                                                 'source_sheet': 'IDT',
                                                                 'source_item': 15},
                     'Check Oil Level of transformer tank and OLTC': {'description': 'Check oil level of '
                                                                                     'transformer tank and OLTC',
                                                                      'parameters': 'Sight glass/MOG for main '
                                                                                    'conservator and separate '
                                                                                    'OLTC conservator vs '
                                                                                    'temperature curve (more than '
                                                                                    '1/2)',
                                                                      'abnormalities': 'Low oil level (less than '
                                                                                       '1/2)',
                                                                      'corrective_actions': 'refill with '
                                                                                            'OEM-approved oil '
                                                                                            'stored in closed '
                                                                                            'container, oil '
                                                                                            'should be moisture '
                                                                                            'and imopurity free '
                                                                                            'and BDV tested',
                                                                      'source_sheet': 'IDT',
                                                                      'source_item': 16},
                     'Check the Breather Silicagel condition': {'description': 'Check breather silica gel '
                                                                               'condition',
                                                                'parameters': 'Colour (blue to pink or orange to '
                                                                              'green/colourless): replace when '
                                                                              'two-thirds changed; oil seal cup '
                                                                              'level; air path clear; breather '
                                                                              'container intact',
                                                                'abnormalities': 'Gel turned pink or white, oil '
                                                                                 'seal dry/dirty, blocked air '
                                                                                 'path',
                                                                'corrective_actions': 'Replace or reactivate '
                                                                                      'silica gel. Ensure air '
                                                                                      'path is sealed and oil cup '
                                                                                      'filled.',
                                                                'source_sheet': 'IDT',
                                                                'source_item': 17},
                     'Noise and vibration': {'description': 'Noise and vibration',
                                             'parameters': 'Humming level, loose parts, core noise, vibration of '
                                                           'radiators/pipes',
                                             'abnormalities': 'Sudden change in sound, rattling, loud buzz',
                                             'corrective_actions': 'Tighten loose parts; inform supplier if noise '
                                                                   'changes.',
                                             'source_sheet': 'IDT',
                                             'source_item': 18},
                     'Pressure relief device (PRD/PRV) and discharge pipe (visual)': {'description': 'Pressure '
                                                                                                     'relief '
                                                                                                     'device '
                                                                                                     '(PRD/PRV) '
                                                                                                     'and '
                                                                                                     'discharge '
                                                                                                     'pipe '
                                                                                                     '(visual)',
                                                                                      'parameters': 'Flag not '
                                                                                                    'operated, '
                                                                                                    'discharge '
                                                                                                    'pipe/deflector '
                                                                                                    'clear, no '
                                                                                                    'oil seepage',
                                                                                      'abnormalities': 'Flag '
                                                                                                       'operated, '
                                                                                                       'blocked '
                                                                                                       'pipe, '
                                                                                                       'leakage',
                                                                                      'corrective_actions': 'Do '
                                                                                                            'not '
                                                                                                            're-energise '
                                                                                                            'until '
                                                                                                            'cause '
                                                                                                            'found; '
                                                                                                            'replace '
                                                                                                            'device '
                                                                                                            'if '
                                                                                                            'damaged.',
                                                                                      'source_sheet': 'IDT',
                                                                                      'source_item': 19},
                     'OLTC (visual): oil level, relay flag, breather, drive box': {'description': 'OLTC (visual): '
                                                                                                  'oil level, '
                                                                                                  'relay flag, '
                                                                                                  'breather, '
                                                                                                  'drive box',
                                                                                   'parameters': 'OLTC '
                                                                                                 'conservator '
                                                                                                 'level, '
                                                                                                 'protective '
                                                                                                 'relay flag not '
                                                                                                 'operated, '
                                                                                                 'breather '
                                                                                                 'condition, '
                                                                                                 'operation '
                                                                                                 'counter, '
                                                                                                 'motor/heater in '
                                                                                                 'drive box',
                                                                                   'abnormalities': 'Low level, '
                                                                                                    'flag '
                                                                                                    'operated, '
                                                                                                    'counter '
                                                                                                    'nearing OEM '
                                                                                                    'interval, '
                                                                                                    'motor MCB '
                                                                                                    'trips',
                                                                                   'corrective_actions': 'Follow '
                                                                                                         'OEM; '
                                                                                                         'call '
                                                                                                         'OEM if '
                                                                                                         'relay '
                                                                                                         'operated.',
                                                                                   'source_sheet': 'IDT',
                                                                                   'source_item': 20},
                     'Radiators, valves and cooling': {'description': 'Radiators, valves and cooling',
                                                       'parameters': 'Radiator inlet/outlet valves fully open, '
                                                                     'fins clean, fans (if any) running',
                                                       'abnormalities': 'Closed valve, blocked fins, fan fail',
                                                       'corrective_actions': 'Open valves, clean fins, repair '
                                                                             'fans.',
                                                       'source_sheet': 'IDT',
                                                       'source_item': 21},
                     'Marshalling box and drive box condition': {'description': 'Marshalling box and drive box '
                                                                                'condition',
                                                                 'parameters': 'Heater and thermostat, lighting, '
                                                                               'door gasket, gland plate sealing, '
                                                                               'no condensation or insects',
                                                                 'abnormalities': 'Damp, corrosion, insects, dead '
                                                                                  'heater',
                                                                 'corrective_actions': 'Seal gaps and replace '
                                                                                       'heater/gasket.',
                                                                 'source_sheet': 'IDT',
                                                                 'source_item': 22},
                     'Nameplate, diagram, tap chart and labels': {'description': 'Nameplate, diagram, tap chart '
                                                                                 'and labels',
                                                                  'parameters': 'Nameplate legible, tap chart '
                                                                                'present, phase/neutral marking, '
                                                                                'danger plates',
                                                                  'abnormalities': 'Fading, missing',
                                                                  'corrective_actions': 'Replace.',
                                                                  'source_sheet': 'IDT',
                                                                  'source_item': 23}},
 'VCB': {'Isolation, LOTO, permit to work, earthing and voltage-free proving before any intrusive check': {'description': 'Isolation, '
                                                                                                                          'LOTO, '
                                                                                                                          'permit '
                                                                                                                          'to '
                                                                                                                          'work, '
                                                                                                                          'earthing '
                                                                                                                          'and '
                                                                                                                          'voltage-free '
                                                                                                                          'proving '
                                                                                                                          'before '
                                                                                                                          'any '
                                                                                                                          'intrusive '
                                                                                                                          'check',
                                                                                                           'parameters': 'Breaker '
                                                                                                                         'OFF '
                                                                                                                         'and '
                                                                                                                         'racked '
                                                                                                                         'to '
                                                                                                                         'Test/Isolated, '
                                                                                                                         'upstream '
                                                                                                                         'and '
                                                                                                                         'downstream '
                                                                                                                         'isolated, '
                                                                                                                         'earthed, '
                                                                                                                         'LOTO '
                                                                                                                         'tags, '
                                                                                                                         'PTW '
                                                                                                                         'signed, '
                                                                                                                         'HT '
                                                                                                                         'gloves/PPE '
                                                                                                                         'valid',
                                                                                                           'abnormalities': 'Any '
                                                                                                                            'live-line '
                                                                                                                            'work '
                                                                                                                            'without '
                                                                                                                            'proof '
                                                                                                                            'of '
                                                                                                                            'dead; '
                                                                                                                            'expired '
                                                                                                                            'gloves/PPE',
                                                                                                           'corrective_actions': 'Stop '
                                                                                                                                 'work. '
                                                                                                                                 'Complete '
                                                                                                                                 'isolation '
                                                                                                                                 'per '
                                                                                                                                 'site '
                                                                                                                                 'SOP/CEA '
                                                                                                                                 'safety '
                                                                                                                                 'regulations '
                                                                                                                                 'before '
                                                                                                                                 'proceeding.',
                                                                                                           'source_sheet': 'VCB '
                                                                                                                           '& '
                                                                                                                           'Kiosk',
                                                                                                           'source_item': 1},
         'Check Breaker cleanliness': {'description': 'Check Breaker cleanliness',
                                       'parameters': 'Dust inside/outside, contacts, vents, pole insulators',
                                       'abnormalities': 'Dust buildup, debris, cobwebs, insects, moisture',
                                       'corrective_actions': 'Clean with dry cloth or vacuum; use OEM-approved '
                                                             'cleaner on insulators only. Avoid liquids near '
                                                             'components.',
                                       'source_sheet': 'VCB & Kiosk',
                                       'source_item': 2},
         'Check Torqing of AC termination': {'description': 'Check torquing of HT (AC) cable termination',
                                             'parameters': 'Tightness per OEM torque value using calibrated '
                                                           'torque wrench; torque-paint/witness marks intact',
                                             'abnormalities': 'Loose terminations, broken witness marks, signs of '
                                                              'overheating',
                                             'corrective_actions': 'Retorque per specification. Replace damaged '
                                                                   'lugs or terminals. Re-apply witness mark.',
                                             'source_sheet': 'VCB & Kiosk',
                                             'source_item': 3},
         'Check bolt, washer and lug for heatup': {'description': 'Check bolt, washer and lug for heat-up',
                                                   'parameters': 'Visual and IR thermography under load (compare '
                                                                 'R-Y-B phases and ambient)',
                                                   'abnormalities': 'Discoloration, heating marks; phase-to-phase '
                                                                    'difference more than 10 C or rise above 40 C '
                                                                    'over ambient',
                                                   'corrective_actions': 'Tighten or replace affected components. '
                                                                         'Raise defect and re-scan after fix.',
                                                   'source_sheet': 'VCB & Kiosk',
                                                   'source_item': 4},
         'Check Breaker Jointing Kit (Any Crack in Jointing Kit)': {'description': 'Check Breaker Jointing Kit / '
                                                                                   'cable termination (any crack '
                                                                                   'in jointing kit)',
                                                                    'parameters': 'Physical inspection of '
                                                                                  'heat-shrink / cold-shrink / '
                                                                                  'stress cone; tracking, oil or '
                                                                                  'compound leakage',
                                                                    'abnormalities': 'Cracks, deformation, '
                                                                                     'tracking marks, partial '
                                                                                     'discharge traces',
                                                                    'corrective_actions': 'Replace damaged '
                                                                                          'jointing kit.',
                                                                    'source_sheet': 'VCB & Kiosk',
                                                                    'source_item': 5},
         'Check manual Spring charge and On/Off': {'description': 'Check manual spring charge and ON/OFF',
                                                   'parameters': 'Smooth manual charging, spring-charged '
                                                                 'indication, mechanical ON/OFF',
                                                   'abnormalities': 'Spring not charging, jamming, abnormal noise',
                                                   'corrective_actions': 'Contact supplier if manual operation '
                                                                         'not working.',
                                                   'source_sheet': 'VCB & Kiosk',
                                                   'source_item': 6},
         'Check operation of Breaker': {'description': 'Check operation of breaker (local and remote)',
                                        'parameters': 'Manual/remote (SCADA) switching in Test position; open and '
                                                      'close status feedback',
                                        'abnormalities': 'Does not switch, delay in operation, feedback mismatch',
                                        'corrective_actions': 'Contact supplier if VCB not operating normally; do '
                                                              'corrective maintenance per VCB supplier guidance.',
                                        'source_sheet': 'VCB & Kiosk',
                                        'source_item': 7},
         'Check the Indication Lamp': {'description': 'Check the indication lamps',
                                       'parameters': 'Status indicators (ON, OFF, spring charged, trip, TCS '
                                                     'healthy)',
                                       'abnormalities': 'Not glowing, wrong indication',
                                       'corrective_actions': 'Check aux supply MCB; replace lamp/LED; contact '
                                                             'supplier if still not working.',
                                       'source_sheet': 'VCB & Kiosk',
                                       'source_item': 8},
         'Check the Annunciator function': {'description': 'Check the annunciator function',
                                            'parameters': 'Alarm system feedback; lamp test and acknowledge',
                                            'abnormalities': 'Not triggering alarms',
                                            'corrective_actions': 'Contact supplier in case of any abnormality.',
                                            'source_sheet': 'VCB & Kiosk',
                                            'source_item': 9},
         'Check the Hooter function': {'description': 'Check the hooter function',
                                       'parameters': 'Audible alert on simulated fault',
                                       'abnormalities': 'No sound during fault',
                                       'corrective_actions': 'Contact supplier in case of any abnormality.',
                                       'source_sheet': 'VCB & Kiosk',
                                       'source_item': 10},
         'Check the Function of Selector switch and TNC Switch and Push Button': {'description': 'Check function '
                                                                                                 'of selector '
                                                                                                 'switch, TNC '
                                                                                                 'switch and push '
                                                                                                 'buttons',
                                                                                  'parameters': 'Mode selection '
                                                                                                '(Local/Remote), '
                                                                                                'Trip-Neutral-Close '
                                                                                                'and manual '
                                                                                                'controls',
                                                                                  'abnormalities': 'Sticky '
                                                                                                   'switches, no '
                                                                                                   'response',
                                                                                  'corrective_actions': 'Check '
                                                                                                        'aux '
                                                                                                        'supply '
                                                                                                        'and all '
                                                                                                        'MCBs; '
                                                                                                        'check '
                                                                                                        'power '
                                                                                                        'pack '
                                                                                                        'working; '
                                                                                                        'if still '
                                                                                                        'not '
                                                                                                        'working, '
                                                                                                        'contact '
                                                                                                        'supplier.',
                                                                                  'source_sheet': 'VCB & Kiosk',
                                                                                  'source_item': 11},
         'Check door lock and door working': {'description': 'Check door lock and door working',
                                              'parameters': 'Door latch, alignment, hinges, lock',
                                              'abnormalities': "Door misaligned, won't close or lock",
                                              'corrective_actions': 'Realign or replace lock.',
                                              'source_sheet': 'VCB & Kiosk',
                                              'source_item': 12},
         'Operation counter and spring charging time': {'description': 'Operation counter and spring charging '
                                                                       'time',
                                                        'parameters': 'Record counter reading; motor '
                                                                      'spring-charge time (typically within OEM '
                                                                      'limit, about 10-15 s)',
                                                        'abnormalities': 'Counter near OEM mechanical/electrical '
                                                                         'endurance; charging time increasing',
                                                        'corrective_actions': 'Log trend. Contact OEM if charging '
                                                                              'time exceeds limit or motor '
                                                                              'current high.',
                                                        'source_sheet': 'VCB & Kiosk',
                                                        'source_item': 13},
         'Mechanical and electrical interlocks': {'description': 'Mechanical and electrical interlocks',
                                                  'parameters': 'Breaker-earth switch, door-breaker, '
                                                                'racking-closed breaker, key interlock',
                                                  'abnormalities': 'Interlock can be bypassed or does not engage',
                                                  'corrective_actions': 'Do not operate. Rectify before '
                                                                        'energisation; call OEM.',
                                                  'source_sheet': 'VCB & Kiosk',
                                                  'source_item': 14},
         'Earth switch operation and status': {'description': 'Earth switch operation and status',
                                               'parameters': 'Smooth operation, closed/open indication, contacts '
                                                             'clean',
                                               'abnormalities': 'Stiff, partial closure, indication mismatch',
                                               'corrective_actions': 'Adjust/lubricate per OEM; replace damaged '
                                                                     'parts.',
                                               'source_sheet': 'VCB & Kiosk',
                                               'source_item': 15},
         'Trip and close coils, trip circuit supervision': {'description': 'Trip and close coils, trip circuit '
                                                                           'supervision',
                                                            'parameters': 'TCS healthy lamp, coil resistance vs '
                                                                          'previous, anti-pumping works, 52a/52b '
                                                                          'feedback',
                                                            'abnormalities': 'TCS fail, coil overheated or burnt '
                                                                             'smell, double closing',
                                                            'corrective_actions': 'Replace coil/relay; check '
                                                                                  'wiring and aux contacts.',
                                                            'source_sheet': 'VCB & Kiosk',
                                                            'source_item': 16},
         'Control power: DC/AC auxiliary supply': {'description': 'Control power: DC/AC auxiliary supply',
                                                   'parameters': 'DC voltage (110/220 V or 24 V) within range, '
                                                                 'MCBs/fuses healthy, DC earth-fault indication '
                                                                 'clear',
                                                   'abnormalities': 'Low DC, earth fault, tripped MCB',
                                                   'corrective_actions': 'Check charger/battery (see HT sheet), '
                                                                         'rectify DC earth fault.',
                                                   'source_sheet': 'VCB & Kiosk',
                                                   'source_item': 17},
         'Space heater, thermostat, panel lighting, humidity': {'description': 'Space heater, thermostat, panel '
                                                                               'lighting, humidity',
                                                                'parameters': 'Heater ON and warm, thermostat '
                                                                              'set, no condensation or moisture',
                                                                'abnormalities': 'Heater dead, water droplets, '
                                                                                 'corrosion',
                                                                'corrective_actions': 'Replace heater/thermostat; '
                                                                                      'seal ingress.',
                                                                'source_sheet': 'VCB & Kiosk',
                                                                'source_item': 18},
         'Cable compartment and entry sealing': {'description': 'Cable compartment and entry sealing',
                                                 'parameters': 'Gland plates sealed, no rodent/insect entry, no '
                                                               'water ingress, cable supports and armour earthing '
                                                               'tight',
                                                 'abnormalities': 'Gaps, droppings, damp, loose gland',
                                                 'corrective_actions': 'Seal with fire-rated compound/PU '
                                                                       'foam/sealant; fix glands and earthing.',
                                                 'source_sheet': 'VCB & Kiosk',
                                                 'source_item': 19},
         'Ventilation, arc vent and pressure-relief flap': {'description': 'Ventilation, arc vent and '
                                                                           'pressure-relief flap',
                                                            'parameters': 'Vents unblocked, flaps free, exhaust '
                                                                          'fan working, no obstruction in front '
                                                                          'of vents',
                                                            'abnormalities': 'Blocked flap, dead fan',
                                                            'corrective_actions': 'Clear and repair.',
                                                            'source_sheet': 'VCB & Kiosk',
                                                            'source_item': 20},
         'Panel earthing and bonding': {'description': 'Panel earthing and bonding',
                                        'parameters': 'Earth bar connection tight, door earthing flexibles, '
                                                      'continuity to station earth',
                                        'abnormalities': 'Loose/corroded link, missing flexible',
                                        'corrective_actions': 'Tighten, replace; test continuity.',
                                        'source_sheet': 'VCB & Kiosk',
                                        'source_item': 21},
         'Safety items and labelling': {'description': 'Safety items and labelling',
                                        'parameters': 'Danger boards, SLD, nameplate legible, fire extinguisher '
                                                      '(CO2/DCP) in date, rubber mat, first-aid, shock chart',
                                        'abnormalities': 'Missing/expired items',
                                        'corrective_actions': 'Replace/restore; record expiry dates.',
                                        'source_sheet': 'VCB & Kiosk',
                                        'source_item': 22}},
 'Transmission line': {'Patrol safety, PPE and permit for rectification': {'description': 'Patrol safety, PPE and '
                                                                                          'permit for '
                                                                                          'rectification',
                                                                           'parameters': 'Treat every line as '
                                                                                         'live. Patrol in pairs, '
                                                                                         'no climbing. Helmet, '
                                                                                         'safety shoes, '
                                                                                         'reflective jacket, '
                                                                                         'binocular, camera/phone '
                                                                                         'with GPS, torch. Stop '
                                                                                         'patrol in lightning, '
                                                                                         'storm or flood. Where a '
                                                                                         'structure carries two '
                                                                                         'circuits (some plants '
                                                                                         'only), treat the other '
                                                                                         'circuit as live and the '
                                                                                         'isolated circuit as '
                                                                                         'possibly induced. Any '
                                                                                         'rectification only '
                                                                                         'under line isolation, '
                                                                                         'proved dead and earthed '
                                                                                         'at the work site with '
                                                                                         'LOTO/PTW',
                                                                           'abnormalities': 'Fallen conductor, '
                                                                                            'broken pole, hanging '
                                                                                            'wire, person or '
                                                                                            'animal near a '
                                                                                            'damaged line',
                                                                           'corrective_actions': 'Keep everyone '
                                                                                                 'at least 8-10 m '
                                                                                                 'away (step '
                                                                                                 'potential). '
                                                                                                 'Inform control '
                                                                                                 'room/DISCOM '
                                                                                                 'immediately and '
                                                                                                 'have the line '
                                                                                                 'isolated. Do '
                                                                                                 'not touch any '
                                                                                                 'conductor or '
                                                                                                 'damaged '
                                                                                                 'structure.',
                                                                           'source_sheet': 'Line Patrolling',
                                                                           'source_item': 1},
                       'Check the insulator crackness from Ground': {'description': 'Check insulator cracks from '
                                                                                    'ground (pin, disc/string, '
                                                                                    'stay)',
                                                                     'parameters': 'Visual from ground with '
                                                                                   'binocular/zoom camera: '
                                                                                   'cracks, chips, '
                                                                                   'flashover/tracking marks, '
                                                                                   'burnt or discoloured '
                                                                                   'porcelain/polymer, missing '
                                                                                   'cotter pins/discs, heavy '
                                                                                   'contamination (dust, bird '
                                                                                   'droppings)',
                                                                     'abnormalities': 'Cracks, flashover marks, '
                                                                                      'tracking, missing disc',
                                                                     'corrective_actions': 'Replace cracked '
                                                                                           'insulators under '
                                                                                           'shutdown/PTW. Record '
                                                                                           'pole/tower number and '
                                                                                           'GPS location for '
                                                                                           'access. Clean '
                                                                                           'contaminated '
                                                                                           'insulators before '
                                                                                           'monsoon.',
                                                                     'source_sheet': 'Line Patrolling',
                                                                     'source_item': 2},
                       'Check conductor Sag from Ground': {'description': 'Check conductor sag from ground',
                                                           'parameters': 'Ground clearance vs standard value '
                                                                         'using laser range finder/clinometer '
                                                                         '(typically 4.6 m for 11 kV and 5.2 m '
                                                                         'for 33 kV in open ground, 6.1 m across '
                                                                         'a street; confirm with CEA/DISCOM); '
                                                                         'equal sag on all three phases; '
                                                                         'clearance at crossings',
                                                           'abnormalities': 'Excessive sag, low clearance, uneven '
                                                                            'sag between phases',
                                                           'corrective_actions': 'Adjust tension or replace '
                                                                                 'conductor under shutdown. '
                                                                                 'Barricade and inform control '
                                                                                 'room if clearance is unsafe.',
                                                           'source_sheet': 'Line Patrolling',
                                                           'source_item': 3},
                       'Check and ensure the pole & Pin insulators are upright and free from slantinng from Ground': {'description': 'Check '
                                                                                                                                     'poles '
                                                                                                                                     'and '
                                                                                                                                     'pin '
                                                                                                                                     'insulators '
                                                                                                                                     'are '
                                                                                                                                     'upright, '
                                                                                                                                     'free '
                                                                                                                                     'from '
                                                                                                                                     'slanting',
                                                                                                                      'parameters': 'Alignment '
                                                                                                                                    'and '
                                                                                                                                    'verticality '
                                                                                                                                    'of '
                                                                                                                                    'pole/cross-arm, '
                                                                                                                                    'pin '
                                                                                                                                    'insulator '
                                                                                                                                    'tilt, '
                                                                                                                                    'binding '
                                                                                                                                    'wire/tie '
                                                                                                                                    'intact, '
                                                                                                                                    'cross-arm '
                                                                                                                                    'level',
                                                                                                                      'abnormalities': 'Slanted '
                                                                                                                                       'poles '
                                                                                                                                       'or '
                                                                                                                                       'tilted '
                                                                                                                                       'insulators, '
                                                                                                                                       'loose '
                                                                                                                                       'tie',
                                                                                                                      'corrective_actions': 'Realign '
                                                                                                                                            'pole, '
                                                                                                                                            're-fix '
                                                                                                                                            'insulators '
                                                                                                                                            'and '
                                                                                                                                            're-tie '
                                                                                                                                            'conductor.',
                                                                                                                      'source_sheet': 'Line '
                                                                                                                                      'Patrolling',
                                                                                                                      'source_item': 4},
                       'Check and ensure poles are with out any damage/observation from Ground': {'description': 'Check '
                                                                                                                 'poles '
                                                                                                                 'are '
                                                                                                                 'without '
                                                                                                                 'any '
                                                                                                                 'damage/observation '
                                                                                                                 'from '
                                                                                                                 'ground',
                                                                                                  'parameters': 'PCC '
                                                                                                                'pole: '
                                                                                                                'cracks, '
                                                                                                                'spalling, '
                                                                                                                'exposed '
                                                                                                                'reinforcement, '
                                                                                                                'rust '
                                                                                                                'stain, '
                                                                                                                'chipped '
                                                                                                                'corners, '
                                                                                                                'leaning/rotation. '
                                                                                                                'Steel '
                                                                                                                'pole/tower: '
                                                                                                                'rust, '
                                                                                                                'corrosion, '
                                                                                                                'bends',
                                                                                                  'abnormalities': 'Cracks, '
                                                                                                                   'rust, '
                                                                                                                   'leaning, '
                                                                                                                   'exposed '
                                                                                                                   'rebar',
                                                                                                  'corrective_actions': 'Repair '
                                                                                                                        'minor '
                                                                                                                        'spalling '
                                                                                                                        'with '
                                                                                                                        'epoxy '
                                                                                                                        'mortar '
                                                                                                                        'or '
                                                                                                                        'replace '
                                                                                                                        'PCC '
                                                                                                                        'pole; '
                                                                                                                        'replace '
                                                                                                                        'if '
                                                                                                                        'structural '
                                                                                                                        'crack/leaning. '
                                                                                                                        'Paint '
                                                                                                                        'rusted '
                                                                                                                        'steel '
                                                                                                                        'sections '
                                                                                                                        'with '
                                                                                                                        'zinc-rich '
                                                                                                                        'paint.',
                                                                                                  'source_sheet': 'Line '
                                                                                                                  'Patrolling',
                                                                                                  'source_item': 5},
                       'Check and cut trees and shrubs during line clearance': {'description': 'Check and cut '
                                                                                               'trees and shrubs '
                                                                                               'along line '
                                                                                               'clearance',
                                                                                'parameters': 'Clearance zone '
                                                                                              'around line; '
                                                                                              'branches and '
                                                                                              'creepers near '
                                                                                              'conductors, on '
                                                                                              'poles and stay '
                                                                                              'wires; danger '
                                                                                              'trees outside '
                                                                                              'corridor that can '
                                                                                              'fall on the line',
                                                                                'abnormalities': 'Vegetation '
                                                                                                 'encroachment, '
                                                                                                 'leaning tree, '
                                                                                                 'creeper on '
                                                                                                 'structure',
                                                                                'corrective_actions': 'Trim/cut '
                                                                                                      'as per '
                                                                                                      'line '
                                                                                                      'clearance '
                                                                                                      'norms '
                                                                                                      'under '
                                                                                                      'shutdown/PTW, '
                                                                                                      'with '
                                                                                                      'landowner/forest '
                                                                                                      'permission '
                                                                                                      'where '
                                                                                                      'needed. '
                                                                                                      'Remove cut '
                                                                                                      'material '
                                                                                                      'from the '
                                                                                                      'corridor.',
                                                                                'source_sheet': 'Line Patrolling',
                                                                                'source_item': 6},
                       'Check conductors are properly seated in its slot from Ground': {'description': 'Check '
                                                                                                       'conductors '
                                                                                                       'are '
                                                                                                       'properly '
                                                                                                       'seated in '
                                                                                                       'slot',
                                                                                        'parameters': 'Conductor '
                                                                                                      'seated in '
                                                                                                      'pin '
                                                                                                      'insulator '
                                                                                                      'groove/clamp, '
                                                                                                      'binding '
                                                                                                      'wire/armour '
                                                                                                      'rod, '
                                                                                                      'dead-end '
                                                                                                      'and jumper '
                                                                                                      'loops, '
                                                                                                      'mid-span '
                                                                                                      'joints, '
                                                                                                      'broken '
                                                                                                      'strands, '
                                                                                                      'bird-caging, '
                                                                                                      'burn marks',
                                                                                        'abnormalities': 'Loose '
                                                                                                         'or '
                                                                                                         'misaligned '
                                                                                                         'conductor, '
                                                                                                         'broken '
                                                                                                         'strands, '
                                                                                                         'burn '
                                                                                                         'marks',
                                                                                        'corrective_actions': 'Re-seat '
                                                                                                              'conductor '
                                                                                                              'and '
                                                                                                              'tighten '
                                                                                                              'clamps; '
                                                                                                              'repair '
                                                                                                              'strands '
                                                                                                              'with '
                                                                                                              'armour '
                                                                                                              'rod/sleeve '
                                                                                                              'or '
                                                                                                              'replace '
                                                                                                              'conductor.',
                                                                                        'source_sheet': 'Line '
                                                                                                        'Patrolling',
                                                                                        'source_item': 7},
                       'Check earth connection to the poles from Ground': {'description': 'Check earth connection '
                                                                                          'to the poles from '
                                                                                          'ground',
                                                                           'parameters': 'Earth wire/strip down '
                                                                                         'the pole: continuity, '
                                                                                         'loose or missing wire, '
                                                                                         'theft, connection to '
                                                                                         'cross-arm, metal parts '
                                                                                         'and LA; tower earth '
                                                                                         'strips (visual). Earth '
                                                                                         'resistance is measured '
                                                                                         'yearly',
                                                                           'abnormalities': 'Missing or loose '
                                                                                            'ground wire, cut '
                                                                                            'earth strip',
                                                                           'corrective_actions': 'Reconnect or '
                                                                                                 'replace earth '
                                                                                                 'wire. Test '
                                                                                                 'grounding '
                                                                                                 'resistance at '
                                                                                                 'the yearly '
                                                                                                 'check.',
                                                                           'source_sheet': 'Line Patrolling',
                                                                           'source_item': 8},
                       'Check the guard wire for properness from Ground': {'description': 'Check the guard wire '
                                                                                          'for properness from '
                                                                                          'ground',
                                                                           'parameters': 'Tension, alignment, '
                                                                                         'continuity, clamps at '
                                                                                         'crossings (guard wire) '
                                                                                         'and shield/earth wire '
                                                                                         'on towers',
                                                                           'abnormalities': 'Slack or broken '
                                                                                            'guard wire, loose '
                                                                                            'clamp',
                                                                           'corrective_actions': 'Tighten or '
                                                                                                 'replace guard '
                                                                                                 'wire.',
                                                                           'source_sheet': 'Line Patrolling',
                                                                           'source_item': 9},
                       'Check the stay insulator healthiness and stay wire properness': {'description': 'Check '
                                                                                                        'stay '
                                                                                                        'insulator '
                                                                                                        'healthiness '
                                                                                                        'and stay '
                                                                                                        'wire '
                                                                                                        'properness',
                                                                                         'parameters': 'Stay set: '
                                                                                                       'rod, '
                                                                                                       'anchor '
                                                                                                       'plate, '
                                                                                                       'turnbuckle, '
                                                                                                       'thimble, '
                                                                                                       'stay '
                                                                                                       'clamp, '
                                                                                                       'stay '
                                                                                                       'insulator; '
                                                                                                       'strand '
                                                                                                       'rust and '
                                                                                                       'breakage; '
                                                                                                       'tension; '
                                                                                                       'stay '
                                                                                                       'guard/marker '
                                                                                                       'visible',
                                                                                         'abnormalities': 'Corrosion, '
                                                                                                          'broken '
                                                                                                          'fittings, '
                                                                                                          'slack '
                                                                                                          'wire, '
                                                                                                          'cracked '
                                                                                                          'stay '
                                                                                                          'insulator, '
                                                                                                          'missing '
                                                                                                          'stay '
                                                                                                          'guard',
                                                                                         'corrective_actions': 'Replace '
                                                                                                               'damaged '
                                                                                                               'stay '
                                                                                                               'insulators '
                                                                                                               'or '
                                                                                                               'retension/replace '
                                                                                                               'stay '
                                                                                                               'wire; '
                                                                                                               'fit '
                                                                                                               'stay '
                                                                                                               'guard '
                                                                                                               'near '
                                                                                                               'roads.',
                                                                                         'source_sheet': 'Line '
                                                                                                         'Patrolling',
                                                                                         'source_item': 10},
                       'PCC pole base and foundation': {'description': 'PCC pole base and foundation',
                                                        'parameters': 'Soil washout/rain cuts at base, concrete '
                                                                      'collar cracks, water logging, nearby '
                                                                      'excavation or road widening, vehicle '
                                                                      'damage; pole guard or barrier near roads',
                                                        'abnormalities': 'Exposed pole base, cracked collar, soil '
                                                                         'subsidence, leaning after rain',
                                                        'corrective_actions': 'Compact and refill soil, '
                                                                              're-concrete collar; fit pole '
                                                                              'guard/crash barrier near road; '
                                                                              'replace pole if damaged.',
                                                        'source_sheet': 'Line Patrolling',
                                                        'source_item': 11},
                       'Cross-arm and hardware': {'description': 'Cross-arm and hardware',
                                                  'parameters': 'Cross-arm tilt, bending, rust, V-brace, bolts, '
                                                                'nuts, washers, cotter pins and top clamp/pin',
                                                  'abnormalities': 'Tilted or bent cross-arm, missing bolt/nut, '
                                                                   'rust',
                                                  'corrective_actions': 'Tighten/replace hardware; replace '
                                                                        'cross-arm under shutdown.',
                                                  'source_sheet': 'Line Patrolling',
                                                  'source_item': 12},
                       'Pole/tower number, phase plates and danger board': {'description': 'Pole/tower number, '
                                                                                           'phase plates and '
                                                                                           'danger board',
                                                                            'parameters': 'Number plate, phase '
                                                                                          'marking (R-Y-B), '
                                                                                          "'Danger 11 kV/33 kV' "
                                                                                          'board, anti-climbing '
                                                                                          'device, reflective '
                                                                                          'stickers on roadside '
                                                                                          'poles',
                                                                            'abnormalities': 'Missing, faded or '
                                                                                             'damaged plate/board',
                                                                            'corrective_actions': 'Replace/refit; '
                                                                                                  'record in '
                                                                                                  'defect '
                                                                                                  'register.',
                                                                            'source_sheet': 'Line Patrolling',
                                                                            'source_item': 13},
                       'Tower body and members': {'description': 'Tower body and members',
                                                  'parameters': 'Bent or missing members, missing bolts/nuts '
                                                                '(theft), loose cleats, anti-theft tack welding, '
                                                                'galvanising loss/rust, step bolts, bird '
                                                                'nests/bee hives, leaning or twist',
                                                  'abnormalities': 'Missing bolts/members, heavy rust, leaning '
                                                                   'tower, nests',
                                                  'corrective_actions': 'Replace missing bolts/members, add '
                                                                        'anti-theft tack welding, touch up with '
                                                                        'zinc-rich paint, remove nests under '
                                                                        'shutdown.',
                                                  'source_sheet': 'Line Patrolling',
                                                  'source_item': 14},
                       'Tower foundation': {'description': 'Tower foundation',
                                            'parameters': 'Cracks/spalling in stub and chimney, stub corrosion at '
                                                          'ground level, soil erosion, water logging, nearby '
                                                          'excavation, flood/nala course change, slope stability',
                                            'abnormalities': 'Exposed footing, cracks, erosion, standing water',
                                            'corrective_actions': 'Backfill/compact, civil repair, protection '
                                                                  'wall/drain; report to engineer immediately if '
                                                                  'footing exposed.',
                                            'source_sheet': 'Line Patrolling',
                                            'source_item': 15},
                       'Double circuit only (if applicable): circuit identification and clearances': {'description': 'Double '
                                                                                                                     'circuit '
                                                                                                                     'only '
                                                                                                                     '(if '
                                                                                                                     'applicable): '
                                                                                                                     'circuit '
                                                                                                                     'identification '
                                                                                                                     'and '
                                                                                                                     'clearances',
                                                                                                      'parameters': 'Circuit '
                                                                                                                    'name '
                                                                                                                    'plates '
                                                                                                                    '(Ckt-1/Ckt-2) '
                                                                                                                    'and '
                                                                                                                    'phase '
                                                                                                                    'marking '
                                                                                                                    'on '
                                                                                                                    'both '
                                                                                                                    'circuits, '
                                                                                                                    'cross-arm '
                                                                                                                    'arrangement, '
                                                                                                                    'phase-to-phase '
                                                                                                                    'clearance '
                                                                                                                    'between '
                                                                                                                    'circuits, '
                                                                                                                    'conductor '
                                                                                                                    'swing/clashing '
                                                                                                                    'between '
                                                                                                                    'circuits, '
                                                                                                                    'jumpers '
                                                                                                                    'between '
                                                                                                                    'circuits',
                                                                                                      'abnormalities': 'Missing '
                                                                                                                       'or '
                                                                                                                       'wrong '
                                                                                                                       'plate, '
                                                                                                                       'wrong '
                                                                                                                       'phase '
                                                                                                                       'marking, '
                                                                                                                       'circuits '
                                                                                                                       'too '
                                                                                                                       'close, '
                                                                                                                       'burn '
                                                                                                                       'marks '
                                                                                                                       'between '
                                                                                                                       'circuits',
                                                                                                      'corrective_actions': 'Replace '
                                                                                                                            'plates/markings; '
                                                                                                                            'restore '
                                                                                                                            'clearance '
                                                                                                                            'under '
                                                                                                                            'shutdown '
                                                                                                                            'of '
                                                                                                                            'both '
                                                                                                                            'circuits; '
                                                                                                                            'inform '
                                                                                                                            'engineer '
                                                                                                                            'before '
                                                                                                                            'any '
                                                                                                                            'work.',
                                                                                                      'source_sheet': 'Line '
                                                                                                                      'Patrolling',
                                                                                                      'source_item': 16},
                       'Double circuit only (if applicable): shutdown and earthing readiness': {'description': 'Double '
                                                                                                               'circuit '
                                                                                                               'only '
                                                                                                               '(if '
                                                                                                               'applicable): '
                                                                                                               'shutdown '
                                                                                                               'and '
                                                                                                               'earthing '
                                                                                                               'readiness',
                                                                                                'parameters': 'Line '
                                                                                                              'earthing '
                                                                                                              'points, '
                                                                                                              'earthing '
                                                                                                              'rods '
                                                                                                              'and '
                                                                                                              'discharge '
                                                                                                              'rods '
                                                                                                              'available; '
                                                                                                              'isolation '
                                                                                                              'points '
                                                                                                              'for '
                                                                                                              'each '
                                                                                                              'circuit '
                                                                                                              'identified '
                                                                                                              'on '
                                                                                                              'route '
                                                                                                              'map; '
                                                                                                              'induced '
                                                                                                              'voltage '
                                                                                                              'risk '
                                                                                                              'noted '
                                                                                                              'for '
                                                                                                              'parallel '
                                                                                                              'circuits',
                                                                                                'abnormalities': 'Unclear '
                                                                                                                 'isolation '
                                                                                                                 'points, '
                                                                                                                 'missing '
                                                                                                                 'earthing '
                                                                                                                 'set',
                                                                                                'corrective_actions': 'Mark '
                                                                                                                      'isolation '
                                                                                                                      'points '
                                                                                                                      'on '
                                                                                                                      'route '
                                                                                                                      'map; '
                                                                                                                      'keep '
                                                                                                                      'earthing '
                                                                                                                      'sets; '
                                                                                                                      'work '
                                                                                                                      'only '
                                                                                                                      'with '
                                                                                                                      'PTW '
                                                                                                                      'and '
                                                                                                                      'both '
                                                                                                                      "circuits' "
                                                                                                                      'status '
                                                                                                                      'confirmed.',
                                                                                                'source_sheet': 'Line '
                                                                                                                'Patrolling',
                                                                                                'source_item': 17},
                       'Disc insulator strings and hardware (tower)': {'description': 'Disc insulator strings and '
                                                                                      'hardware (tower)',
                                                                       'parameters': 'String tilt, missing disc, '
                                                                                     'cotter pins, yoke plate, '
                                                                                     'shackle, ball-and-socket, '
                                                                                     'arcing horn gap, '
                                                                                     'suspension/tension clamp, '
                                                                                     'jumper loop clearance under '
                                                                                     'wind',
                                                                       'abnormalities': 'Missing disc, bent '
                                                                                        'hardware, hot clamp, '
                                                                                        'loose jumper',
                                                                       'corrective_actions': 'Replace damaged '
                                                                                             'discs/hardware '
                                                                                             'under shutdown; '
                                                                                             'adjust jumper '
                                                                                             'clearance.',
                                                                       'source_sheet': 'Line Patrolling',
                                                                       'source_item': 18},
                       'Jumpers, joints and clamps': {'description': 'Jumpers, joints and clamps',
                                                      'parameters': 'Mid-span joints, PG/T-clamps, dead-end '
                                                                    'clamps: discoloration, burn marks, loose or '
                                                                    'drooping jumpers, Al-Cu bimetallic corrosion',
                                                      'abnormalities': 'Burnt joint, discolored clamp, loose '
                                                                       'jumper',
                                                      'corrective_actions': 'Clean and retighten with bimetallic '
                                                                            'washer; replace burnt joint/clamp.',
                                                      'source_sheet': 'Line Patrolling',
                                                      'source_item': 19},
                       'Corridor encroachment and third-party activity': {'description': 'Corridor encroachment '
                                                                                         'and third-party '
                                                                                         'activity',
                                                                          'parameters': 'Buildings, scaffolding, '
                                                                                        'hoardings, '
                                                                                        'cranes/tippers/JCB '
                                                                                        'working near line, kite '
                                                                                        'strings/metallic '
                                                                                        'balloons, irrigation '
                                                                                        'pipes, tall crops, '
                                                                                        'stacked material/hay, '
                                                                                        'burning of stubble or '
                                                                                        'garbage, telecom/cable '
                                                                                        'TV wires on poles, '
                                                                                        'illegal hooking/tapping, '
                                                                                        'mining',
                                                                          'abnormalities': 'Activity within '
                                                                                           'safety clearance, '
                                                                                           'wires tied to pole, '
                                                                                           'burning below line',
                                                                          'corrective_actions': 'Stop the '
                                                                                                'activity, '
                                                                                                'photograph, '
                                                                                                'inform '
                                                                                                'plant/DISCOM, '
                                                                                                'serve notice; '
                                                                                                'remove illegal '
                                                                                                'connections.',
                                                                          'source_sheet': 'Line Patrolling',
                                                                          'source_item': 20},
                       'Crossings (road, rail, river, canal, other lines)': {'description': 'Crossings (road, '
                                                                                            'rail, river, canal, '
                                                                                            'other lines)',
                                                                             'parameters': 'Guard cradle/guard '
                                                                                           'wire, height gauge '
                                                                                           'and warning board, '
                                                                                           'clearance at maximum '
                                                                                           'sag, double '
                                                                                           'dead-end/strengthened '
                                                                                           'structures at rail '
                                                                                           'and road crossings, '
                                                                                           'tower above flood '
                                                                                           'level',
                                                                             'abnormalities': 'Low clearance, '
                                                                                              'missing '
                                                                                              'cradle/board, '
                                                                                              'damaged crossing '
                                                                                              'structure',
                                                                             'corrective_actions': 'Restore '
                                                                                                   'clearance; '
                                                                                                   'replace '
                                                                                                   'cradle/board; '
                                                                                                   'inform '
                                                                                                   'concerned '
                                                                                                   'authority.',
                                                                             'source_sheet': 'Line Patrolling',
                                                                             'source_item': 21},
                       'Terminal/cable-riser pole (overhead line to HT cable)': {'description': 'Terminal/cable-riser '
                                                                                                'pole (overhead '
                                                                                                'line to HT '
                                                                                                'cable)',
                                                                                 'parameters': 'HT cable '
                                                                                               'termination/jointing '
                                                                                               'kit, riser GI '
                                                                                               'pipe and guard, '
                                                                                               'cable lugs, '
                                                                                               'clamps and '
                                                                                               'sealing, LA and '
                                                                                               'earth, danger '
                                                                                               'plate, '
                                                                                               'anti-climbing '
                                                                                               'device',
                                                                                 'abnormalities': 'Cracked '
                                                                                                  'termination, '
                                                                                                  'tracking, '
                                                                                                  'loose lug, '
                                                                                                  'damaged riser '
                                                                                                  'pipe',
                                                                                 'corrective_actions': 'Replace '
                                                                                                       'jointing '
                                                                                                       'kit by '
                                                                                                       'qualified '
                                                                                                       'jointer; '
                                                                                                       'tighten '
                                                                                                       'lugs; '
                                                                                                       'repair '
                                                                                                       'riser '
                                                                                                       'pipe; '
                                                                                                       'replace '
                                                                                                       'damaged '
                                                                                                       'LA.',
                                                                                 'source_sheet': 'Line Patrolling',
                                                                                 'source_item': 22},
                       'Anti-theft check': {'description': 'Anti-theft check',
                                            'parameters': 'Conductor, stay wire, earth strip, tower bolts, '
                                                          'cross-arm and insulators missing or cut; signs of '
                                                          'digging at footing',
                                            'abnormalities': 'Missing parts, cut earth/stay, digging',
                                            'corrective_actions': 'Report to security/FIR, restore with '
                                                                  'anti-theft fasteners, inform DISCOM.',
                                            'source_sheet': 'Line Patrolling',
                                            'source_item': 23},
                       'Electricty Theft': {'description': 'Electricty Theft',
                                            'parameters': 'Any jumer or supply being taken by unauthorised party',
                                            'abnormalities': 'any cable or conductor connection for elecytricty '
                                                             'theft',
                                            'corrective_actions': 'take phographs and photos of the location and '
                                                                  'report to HO team',
                                            'source_sheet': 'Line Patrolling',
                                            'source_item': 24}},
 'Earth pit': {},
 'Miscellaneous': {},
 'Four Pole': {"Isolation, LOTO, permit to work and discharge/earthing for all 'Shutdown' items": {'description': 'Isolation, '
                                                                                                                  'LOTO, '
                                                                                                                  'permit '
                                                                                                                  'to '
                                                                                                                  'work '
                                                                                                                  'and '
                                                                                                                  'discharge/earthing '
                                                                                                                  'for '
                                                                                                                  'all '
                                                                                                                  "'Shutdown' "
                                                                                                                  'items',
                                                                                                   'parameters': 'Feeder/bay '
                                                                                                                 'isolated '
                                                                                                                 'at '
                                                                                                                 'both '
                                                                                                                 'ends, '
                                                                                                                 'isolator '
                                                                                                                 'open '
                                                                                                                 'and '
                                                                                                                 'earth '
                                                                                                                 'blades '
                                                                                                                 'closed, '
                                                                                                                 'proved '
                                                                                                                 'dead, '
                                                                                                                 'LOTO '
                                                                                                                 'tags '
                                                                                                                 'and '
                                                                                                                 'PTW '
                                                                                                                 'in '
                                                                                                                 'place, '
                                                                                                                 'HT '
                                                                                                                 'gloves/PPE '
                                                                                                                 'valid. '
                                                                                                                 'For '
                                                                                                                 "'Online' "
                                                                                                                 'items '
                                                                                                                 'keep '
                                                                                                                 'safe '
                                                                                                                 'distance '
                                                                                                                 'from '
                                                                                                                 'live '
                                                                                                                 'parts '
                                                                                                                 'and '
                                                                                                                 'wear '
                                                                                                                 'PPE; '
                                                                                                                 'no '
                                                                                                                 'climbing '
                                                                                                                 'on '
                                                                                                                 'structures '
                                                                                                                 'while '
                                                                                                                 'live',
                                                                                                   'abnormalities': 'Work '
                                                                                                                    'started '
                                                                                                                    'without '
                                                                                                                    'proof '
                                                                                                                    'of '
                                                                                                                    'dead; '
                                                                                                                    'person '
                                                                                                                    'within '
                                                                                                                    'safety '
                                                                                                                    'clearance '
                                                                                                                    'of '
                                                                                                                    'live '
                                                                                                                    'parts',
                                                                                                   'corrective_actions': 'Stop '
                                                                                                                         'work. '
                                                                                                                         'Complete '
                                                                                                                         'isolation '
                                                                                                                         'per '
                                                                                                                         'site '
                                                                                                                         'SOP '
                                                                                                                         'and '
                                                                                                                         'CEA '
                                                                                                                         'safety '
                                                                                                                         'regulations '
                                                                                                                         'first.',
                                                                                                   'source_sheet': '4 '
                                                                                                                   'pole '
                                                                                                                   '- '
                                                                                                                   'PLant '
                                                                                                                   'side',
                                                                                                   'source_item': 1},
               'Bush Should be Clear': {'description': 'Bushes/vegetation should be clear',
                                        'parameters': 'No vegetation, bushes or creepers in yard, along fence, '
                                                      'around structures, isolators, LA and earth pits; safe '
                                                      'clearance from live parts maintained',
                                        'abnormalities': 'Overgrown bushes near switchyard, creepers on '
                                                         'structures, dry grass (fire hazard)',
                                        'corrective_actions': 'Trim/remove bushes, maintain clearance. Keep '
                                                              'gravel clean. Dispose dry waste outside the yard.',
                                        'source_sheet': '4 pole - PLant side',
                                        'source_item': 2},
               'Oil Leakage Issue from CT & PT': {'description': 'Oil leakage from CT and PT',
                                                  'parameters': 'Check oil level indicator/expansion bellows and '
                                                                'leaks at base, terminal box, drain plug and '
                                                                'porcelain joints; cracks or tracking; sealed '
                                                                'terminal box',
                                                  'abnormalities': 'Oil stains, low oil level, bulged bellows, '
                                                                   'moisture in terminal box',
                                                  'corrective_actions': 'Identify leakage source. CT/PT are '
                                                                        'sealed units: do not open or refill on '
                                                                        'site; contact supplier. Replace gasket '
                                                                        'on terminal box.',
                                                  'source_sheet': '4 pole - PLant side',
                                                  'source_item': 3},
               'Yard Fencing Should be Proper': {'description': 'Yard fencing should be proper',
                                                 'parameters': 'Fence integrity, gate lock and hinges, rust, '
                                                               'gaps/digging under fence, danger and caution '
                                                               'boards on gate and fence, fence and gate earthing',
                                                 'abnormalities': 'Broken or rusted fence, gaps, missing board, '
                                                                  'loose gate lock',
                                                 'corrective_actions': 'Repair or replace damaged fencing; '
                                                                       'replace boards; restore fence earth '
                                                                       'links.',
                                                 'source_sheet': '4 pole - PLant side',
                                                 'source_item': 4},
               'Grease on Isolator Operating Part': {'description': 'Grease on isolator operating parts',
                                                     'parameters': 'Proper lubrication of moving parts, bearings, '
                                                                   'linkages and gear box; smooth operation; '
                                                                   'contact blade condition; use OEM-approved '
                                                                   'contact grease on contacts and general grease '
                                                                   'on bearings',
                                                     'abnormalities': 'Dry or stiff isolator, unusual noise, hard '
                                                                      'operation, burn/pitting on contacts',
                                                     'corrective_actions': 'Apply appropriate grease/lubricant '
                                                                           'only with isolator isolated and '
                                                                           'earthed. Call OEM if operation is '
                                                                           'hard or contacts are burnt.',
                                                     'source_sheet': '4 pole - PLant side',
                                                     'source_item': 5},
               'Equipment Bushing Proper': {'description': 'Equipment bushing proper',
                                            'parameters': 'No cracks, dirt or moisture on bushings and post '
                                                          'insulators of CT, PT, isolator, DO fuse and LA; no '
                                                          'chipping or flashover marks',
                                            'abnormalities': 'Cracked or dirty bushings, tracking marks, bird '
                                                             'droppings',
                                            'corrective_actions': 'Clean with dry cloth under shutdown; replace '
                                                                  'if damaged.',
                                            'source_sheet': '4 pole - PLant side',
                                            'source_item': 6},
               'Jointing Kits Proper': {'description': 'Jointing kits proper (HT cable)',
                                        'parameters': 'Heat-shrink/cold-shrink terminations and straight joints: '
                                                      'secure, insulated, no cracks, tracking or oil/compound '
                                                      'leak; cable lug tight; sheath/armour earthing; cable '
                                                      'marker/tag',
                                        'abnormalities': 'Loose or corroded joints, cracked kit, tracking marks, '
                                                         'burnt smell',
                                        'corrective_actions': 'Tighten/replace damaged joints; replace jointing '
                                                              'kit by qualified jointer.',
                                        'source_sheet': '4 pole - PLant side',
                                        'source_item': 7},
               'Check ERT Value, if required fill water in pits': {'description': 'Check ERT value; if required '
                                                                                  'fill water in pits',
                                                                   'parameters': 'Earth pit condition and '
                                                                                 'connections; clamp-on or '
                                                                                 'fall-of-potential reading of '
                                                                                 'body, neutral and LA earth pits '
                                                                                 '(design value, typically 1 ohm '
                                                                                 'or less for the yard grid per '
                                                                                 'IS 3043); pit cover, chamber '
                                                                                 'and test link',
                                                                   'abnormalities': 'High resistance (above '
                                                                                    'design value), dry or silted '
                                                                                    'pit, corroded strip, missing '
                                                                                    'cover',
                                                                   'corrective_actions': 'Fix connections; add '
                                                                                         'water only as a '
                                                                                         'temporary measure and '
                                                                                         'do not use salt '
                                                                                         '(corrodes '
                                                                                         'strip/electrode). Use '
                                                                                         'chemical/maintenance-free '
                                                                                         'earthing '
                                                                                         '(bentonite/GEM) as a '
                                                                                         'permanent fix.',
                                                                   'source_sheet': '4 pole - PLant side',
                                                                   'source_item': 8},
               'No Chattering Sound Heard in Yard': {'description': 'No chattering sound heard in yard',
                                                     'parameters': 'Listen/ultrasonic scan for clicking, buzzing, '
                                                                   'hissing or corona on bushings, isolators, '
                                                                   'jumpers and fuses, especially on humid '
                                                                   'mornings; loose connections or faulty relays',
                                                     'abnormalities': 'Unusual clicking or buzzing, hissing, blue '
                                                                      'glow at dusk',
                                                     'corrective_actions': 'Inspect and fix loose components; '
                                                                           'clean/replace insulator or tighten '
                                                                           'clamp; inform supplier if source not '
                                                                           'found.',
                                                     'source_sheet': '4 pole - PLant side',
                                                     'source_item': 9},
               'Yard Greet Should be Proper': {'description': 'Yard gravel should be proper',
                                               'parameters': 'Gravel spread evenly (typically 100-150 mm), no '
                                                             'weed, no muddy patches, no waterlogging, drainage '
                                                             'and trench covers intact',
                                               'abnormalities': 'Muddy, uneven surface, water accumulation, weed '
                                                                'growth',
                                               'corrective_actions': 'Add gravel, level surface, ensure proper '
                                                                     'drainage; use anti-weed sheet if needed.',
                                               'source_sheet': '4 pole - PLant side',
                                               'source_item': 10},
               'Fire Bucket Filled with Sand & Fire Extinguisher Filled': {'description': 'Fire bucket filled '
                                                                                          'with sand and fire '
                                                                                          'extinguisher filled',
                                                                           'parameters': 'Sand dry and full, '
                                                                                         'buckets and stand '
                                                                                         'intact, CO2/DCP '
                                                                                         'extinguisher gauge in '
                                                                                         'green zone, seal '
                                                                                         'intact, refill/expiry '
                                                                                         'date valid, accessible '
                                                                                         'and signboard visible',
                                                                           'abnormalities': 'Empty bucket, wet '
                                                                                            'sand, expired or '
                                                                                            'discharged '
                                                                                            'extinguisher',
                                                                           'corrective_actions': 'Refill sand, '
                                                                                                 'replace/refill '
                                                                                                 'extinguisher, '
                                                                                                 'record expiry '
                                                                                                 'date.',
                                                                           'source_sheet': '4 pole - PLant side',
                                                                           'source_item': 11},
               'Check horngap Rod and Fuse Condition': {'description': 'Check horn gap rod and fuse condition (DO '
                                                                       'fuse)',
                                                        'parameters': 'Fuse colour and carbon deposit on rod, '
                                                                      'fuse link rating correct, contacts tight, '
                                                                      'fuse tube/porcelain cracks, horn gap '
                                                                      'setting as per approved drawing, hinge and '
                                                                      'latch free',
                                                        'abnormalities': 'Fuse turned black, carbon accumulation '
                                                                         'on bolt/tightness area, loose contacts, '
                                                                         'gap changed',
                                                        'corrective_actions': 'Replace fuse if turned black; '
                                                                              'clean rod where carbon is '
                                                                              'deposited; tighten contacts; reset '
                                                                              'gap per drawing (replace damaged '
                                                                              'parts).',
                                                        'source_sheet': '4 pole - PLant side',
                                                        'source_item': 12},
               'Check the LA is Intact': {'description': 'Check the LA is intact (station type)',
                                          'parameters': 'Housing clean and uncracked, top and bottom clamps '
                                                        'tight, earth lead tight and corrosion free, surge '
                                                        'counter and leakage current indicator (if fitted) noted, '
                                                        'disconnector/insulating base intact',
                                          'abnormalities': 'Damaged LA, loose connections, counter jump, high '
                                                           'leakage current, hot spot',
                                          'corrective_actions': 'Replace damaged LA; tighten connections; record '
                                                                'counter and leakage reading.',
                                          'source_sheet': '4 pole - PLant side',
                                          'source_item': 13},
               'Isolators and earth switch - condition': {'description': 'Isolators and earth switch - condition',
                                                          'parameters': 'Alignment of blades and fixed contacts, '
                                                                        'springs and stops, operating handle and '
                                                                        'lock, interlock between isolator and '
                                                                        'earth switch/breaker, rubber mat at '
                                                                        'handle, position indication, insulators '
                                                                        'clean, gear box and rod earthing',
                                                          'abnormalities': 'Misalignment, loose bolts, interlock '
                                                                           'bypass, burnt contacts, missing mat, '
                                                                           'rust on linkages',
                                                          'corrective_actions': 'Do not operate if interlock is '
                                                                                'defective. Realign/tighten under '
                                                                                'shutdown; call OEM for contacts '
                                                                                'or interlock repair.',
                                                          'source_sheet': '4 pole - PLant side',
                                                          'source_item': 14},
               'Insulators (post, pin, string) condition': {'description': 'Insulators (post, pin, string) '
                                                                           'condition',
                                                            'parameters': 'Cracks, chipping, flashover and '
                                                                          'tracking marks, glaze loss, cap and '
                                                                          'pin corrosion, contamination (dust, '
                                                                          'bird droppings, salt), cemented '
                                                                          'joints, string hardware and cotter '
                                                                          'pins',
                                                            'abnormalities': 'Cracked/chipped units, tracking, '
                                                                             'heavy deposit, rusted hardware',
                                                            'corrective_actions': 'Clean with dry cloth under '
                                                                                  'shutdown; replace damaged '
                                                                                  'units; plan pollution cleaning '
                                                                                  'before monsoon.',
                                                            'source_sheet': '4 pole - PLant side',
                                                            'source_item': 15},
               'Dog conductor, jumpers, clamps and connectors': {'description': 'Dog conductor, jumpers, clamps '
                                                                                'and connectors',
                                                                 'parameters': 'Sag and tension, broken '
                                                                               'strands/bird-caging, corrosion, '
                                                                               'bimetallic washers on Al-Cu '
                                                                               'joints, clamp and bolt tightness '
                                                                               '(witness marks), spacers, no '
                                                                               'swinging jumpers; clearances to '
                                                                               'structure and ground not reduced',
                                                                 'abnormalities': 'Broken strands, loose/burnt '
                                                                                  'clamp, green corrosion, '
                                                                                  'excessive sag',
                                                                 'corrective_actions': 'Retighten or replace '
                                                                                       'clamp/connector; repair '
                                                                                       'or replace damaged '
                                                                                       'conductor; re-tension.',
                                                                 'source_sheet': '4 pole - PLant side',
                                                                 'source_item': 16},
               'Visual inspection of the four-pole structure': {'description': 'I-beam / gantry structure and '
                                                                               'foundation',
                                                                'parameters': 'Rust/galvanising loss, bent or '
                                                                              'missing members, loose or missing '
                                                                              'nuts and bolts, base plate and '
                                                                              'anchor bolts, foundation cracks, '
                                                                              'tilt, anti-climbing device and '
                                                                              'step bolts',
                                                                'abnormalities': 'Heavy rust, loose bolts, '
                                                                                 'cracked foundation, leaning '
                                                                                 'structure',
                                                                'corrective_actions': 'Tighten/replace bolts; '
                                                                                      'paint or zinc-spray '
                                                                                      'touch-up; civil repair; '
                                                                                      'report tilt to engineer.',
                                                                'source_sheet': '4 pole - PLant side',
                                                                'source_item': 17},
               'Earthing strip and earthing connections': {'description': 'Earthing strip and earthing '
                                                                          'connections',
                                                           'parameters': 'GI/copper strip joints and bolts tight, '
                                                                         'no corrosion/damage, equipment earth '
                                                                         '(two points), structure earth, fence '
                                                                         'and gate earth, LA earth, neutral '
                                                                         'earth, strip painted/marked and '
                                                                         'visible, no theft; below-ground joints '
                                                                         'sampled by opening a pit',
                                                           'abnormalities': 'Loose/rusted joint, missing strip, '
                                                                            'broken bond, bimetallic corrosion',
                                                           'corrective_actions': 'Tighten, clean and apply '
                                                                                 'anti-corrosion compound or '
                                                                                 'replace strip; report theft; '
                                                                                 'restore continuity.',
                                                           'source_sheet': '4 pole - PLant side',
                                                           'source_item': 18},
               'HT cable route, risers and terminations': {'description': 'HT cable route, risers and '
                                                                          'terminations',
                                                           'parameters': 'Cable riser pipe/guard intact and '
                                                                         'sealed, cable trench/tray covers in '
                                                                         'place, trench dry, route markers and '
                                                                         'warning tape, cable support and bending '
                                                                         'radius, gland and sealing, no rodent '
                                                                         'entry',
                                                           'abnormalities': 'Open trench, water in trench, '
                                                                            'exposed cable, damaged pipe, rodent '
                                                                            'signs',
                                                           'corrective_actions': 'Close and drain trench; replace '
                                                                                 'covers and seal entries; '
                                                                                 'protect exposed cable.',
                                                           'source_sheet': '4 pole - PLant side',
                                                           'source_item': 19},
               'Lightning protection (mast / shield wire, if provided)': {'description': 'Lightning protection '
                                                                                         '(mast / shield wire, if '
                                                                                         'provided)',
                                                                          'parameters': 'Mast and shield wire '
                                                                                        'intact, earth '
                                                                                        'down-conductor and '
                                                                                        'joints, test link',
                                                                          'abnormalities': 'Broken wire, loose '
                                                                                           'earth, corrosion',
                                                                          'corrective_actions': 'Repair/replace; '
                                                                                                'check earth '
                                                                                                'connection.',
                                                                          'source_sheet': '4 pole - PLant side',
                                                                          'source_item': 20},
               'Bird and animal protection': {'description': 'Bird and animal protection',
                                              'parameters': 'Nests removed, bird spikes/guards/diverters intact, '
                                                            'no snake or rodent holes in yard or trench',
                                              'abnormalities': 'Nests on structure or isolator, droppings on '
                                                               'insulators, burrows',
                                              'corrective_actions': 'Remove nests safely under shutdown; repair '
                                                                    'guards; seal holes.',
                                              'source_sheet': '4 pole - PLant side',
                                              'source_item': 21},
               'Yard lighting, emergency light and signage': {'description': 'Yard lighting, emergency light and '
                                                                             'signage',
                                                              'parameters': 'Yard and gate lights working, '
                                                                            'emergency/torch available, danger '
                                                                            'boards on structures, SLD, shock '
                                                                            'treatment chart and equipment labels '
                                                                            'legible',
                                                              'abnormalities': 'Light not working, missing or '
                                                                               'faded board',
                                                              'corrective_actions': 'Replace lamps/boards; fix '
                                                                                    'cable fault.',
                                                              'source_sheet': '4 pole - PLant side',
                                                              'source_item': 22},
               'Safety items and PPE': {'description': 'Safety items and PPE',
                                        'parameters': 'HT gloves (test date), rubber mats, insulated '
                                                      'stick/hot-stick if used, earthing rods and discharge rods, '
                                                      'first-aid box, key register',
                                        'abnormalities': 'Missing item, expired test date, damaged glove',
                                        'corrective_actions': 'Replace/retest; record expiry dates.',
                                        'source_sheet': '4 pole - PLant side',
                                        'source_item': 23},
               'Drainage and monsoon readiness': {'description': 'Drainage and monsoon readiness',
                                                  'parameters': 'Drain channels and culverts clear, no erosion '
                                                                'near foundations, pit covers and trenches above '
                                                                'water level',
                                                  'abnormalities': 'Blocked drain, erosion, water standing',
                                                  'corrective_actions': 'Clear drains; fill and compact eroded '
                                                                        'areas.',
                                                  'source_sheet': '4 pole - PLant side',
                                                  'source_item': 24}},
 'GSS-side Switchyard': {"Isolation, LOTO, permit to work and discharge/earthing for all 'Shutdown' items": {'description': 'Isolation, '
                                                                                                                            'LOTO, '
                                                                                                                            'permit '
                                                                                                                            'to '
                                                                                                                            'work '
                                                                                                                            'and '
                                                                                                                            'discharge/earthing '
                                                                                                                            'for '
                                                                                                                            'all '
                                                                                                                            "'Shutdown' "
                                                                                                                            'items',
                                                                                                             'parameters': 'Feeder/bay '
                                                                                                                           'isolated '
                                                                                                                           'at '
                                                                                                                           'both '
                                                                                                                           'ends, '
                                                                                                                           'isolator '
                                                                                                                           'open '
                                                                                                                           'and '
                                                                                                                           'earth '
                                                                                                                           'blades '
                                                                                                                           'closed, '
                                                                                                                           'proved '
                                                                                                                           'dead, '
                                                                                                                           'LOTO '
                                                                                                                           'tags '
                                                                                                                           'and '
                                                                                                                           'PTW '
                                                                                                                           'in '
                                                                                                                           'place, '
                                                                                                                           'HT '
                                                                                                                           'gloves/PPE '
                                                                                                                           'valid. '
                                                                                                                           'For '
                                                                                                                           "'Online' "
                                                                                                                           'items '
                                                                                                                           'keep '
                                                                                                                           'safe '
                                                                                                                           'distance '
                                                                                                                           'from '
                                                                                                                           'live '
                                                                                                                           'parts '
                                                                                                                           'and '
                                                                                                                           'wear '
                                                                                                                           'PPE; '
                                                                                                                           'no '
                                                                                                                           'climbing '
                                                                                                                           'on '
                                                                                                                           'structures '
                                                                                                                           'while '
                                                                                                                           'live',
                                                                                                             'abnormalities': 'Work '
                                                                                                                              'started '
                                                                                                                              'without '
                                                                                                                              'proof '
                                                                                                                              'of '
                                                                                                                              'dead; '
                                                                                                                              'person '
                                                                                                                              'within '
                                                                                                                              'safety '
                                                                                                                              'clearance '
                                                                                                                              'of '
                                                                                                                              'live '
                                                                                                                              'parts',
                                                                                                             'corrective_actions': 'Stop '
                                                                                                                                   'work. '
                                                                                                                                   'Complete '
                                                                                                                                   'isolation '
                                                                                                                                   'per '
                                                                                                                                   'site '
                                                                                                                                   'SOP '
                                                                                                                                   'and '
                                                                                                                                   'CEA '
                                                                                                                                   'safety '
                                                                                                                                   'regulations '
                                                                                                                                   'first.',
                                                                                                             'source_sheet': '4 '
                                                                                                                             'pole '
                                                                                                                             '- '
                                                                                                                             'GSS '
                                                                                                                             'side',
                                                                                                             'source_item': 1},
                         'Bush Should be Clear': {'description': 'Bushes/vegetation should be clear',
                                                  'parameters': 'No vegetation, bushes or creepers in yard, along '
                                                                'fence, around structures, isolators, LA and '
                                                                'earth pits; safe clearance from live parts '
                                                                'maintained',
                                                  'abnormalities': 'Overgrown bushes near switchyard, creepers on '
                                                                   'structures, dry grass (fire hazard)',
                                                  'corrective_actions': 'Trim/remove bushes, maintain clearance. '
                                                                        'Keep gravel clean. Dispose dry waste '
                                                                        'outside the yard.',
                                                  'source_sheet': '4 pole - GSS side',
                                                  'source_item': 2},
                         'Oil Leakage Issue from CT & PT': {'description': 'Oil leakage from CT and PT',
                                                            'parameters': 'Check oil level indicator/expansion '
                                                                          'bellows and leaks at base, terminal '
                                                                          'box, drain plug and porcelain joints; '
                                                                          'cracks or tracking; sealed terminal '
                                                                          'box',
                                                            'abnormalities': 'Oil stains, low oil level, bulged '
                                                                             'bellows, moisture in terminal box',
                                                            'corrective_actions': 'Identify leakage source. CT/PT '
                                                                                  'are sealed units: do not open '
                                                                                  'or refill on site; contact '
                                                                                  'supplier. Replace gasket on '
                                                                                  'terminal box.',
                                                            'source_sheet': '4 pole - GSS side',
                                                            'source_item': 3},
                         'Yard Fencing Should be Proper': {'description': 'Yard fencing should be proper',
                                                           'parameters': 'Fence integrity, gate lock and hinges, '
                                                                         'rust, gaps/digging under fence, danger '
                                                                         'and caution boards on gate and fence, '
                                                                         'fence and gate earthing',
                                                           'abnormalities': 'Broken or rusted fence, gaps, '
                                                                            'missing board, loose gate lock',
                                                           'corrective_actions': 'Repair or replace damaged '
                                                                                 'fencing; replace boards; '
                                                                                 'restore fence earth links.',
                                                           'source_sheet': '4 pole - GSS side',
                                                           'source_item': 4},
                         'Grease on Isolator Operating Part': {'description': 'Grease on isolator operating parts',
                                                               'parameters': 'Proper lubrication of moving parts, '
                                                                             'bearings, linkages and gear box; '
                                                                             'smooth operation; contact blade '
                                                                             'condition; use OEM-approved contact '
                                                                             'grease on contacts and general '
                                                                             'grease on bearings',
                                                               'abnormalities': 'Dry or stiff isolator, unusual '
                                                                                'noise, hard operation, '
                                                                                'burn/pitting on contacts',
                                                               'corrective_actions': 'Apply appropriate '
                                                                                     'grease/lubricant only with '
                                                                                     'isolator isolated and '
                                                                                     'earthed. Call OEM if '
                                                                                     'operation is hard or '
                                                                                     'contacts are burnt.',
                                                               'source_sheet': '4 pole - GSS side',
                                                               'source_item': 5},
                         'Equipment Bushing Proper': {'description': 'Equipment bushing proper',
                                                      'parameters': 'No cracks, dirt or moisture on bushings and '
                                                                    'post insulators of CT, PT, isolator, DO fuse '
                                                                    'and LA; no chipping or flashover marks',
                                                      'abnormalities': 'Cracked or dirty bushings, tracking '
                                                                       'marks, bird droppings',
                                                      'corrective_actions': 'Clean with dry cloth under shutdown; '
                                                                            'replace if damaged.',
                                                      'source_sheet': '4 pole - GSS side',
                                                      'source_item': 6},
                         'Jointing Kits Proper': {'description': 'Jointing kits proper (HT cable)',
                                                  'parameters': 'Heat-shrink/cold-shrink terminations and '
                                                                'straight joints: secure, insulated, no cracks, '
                                                                'tracking or oil/compound leak; cable lug tight; '
                                                                'sheath/armour earthing; cable marker/tag',
                                                  'abnormalities': 'Loose or corroded joints, cracked kit, '
                                                                   'tracking marks, burnt smell',
                                                  'corrective_actions': 'Tighten/replace damaged joints; replace '
                                                                        'jointing kit by qualified jointer.',
                                                  'source_sheet': '4 pole - GSS side',
                                                  'source_item': 7},
                         'Check ERT Value, if required fill water in pits': {'description': 'Check ERT value; if '
                                                                                            'required fill water '
                                                                                            'in pits',
                                                                             'parameters': 'Earth pit condition '
                                                                                           'and connections; '
                                                                                           'clamp-on or '
                                                                                           'fall-of-potential '
                                                                                           'reading of body, '
                                                                                           'neutral and LA earth '
                                                                                           'pits (design value, '
                                                                                           'typically 1 ohm or '
                                                                                           'less for the yard '
                                                                                           'grid per IS 3043); '
                                                                                           'pit cover, chamber '
                                                                                           'and test link',
                                                                             'abnormalities': 'High resistance '
                                                                                              '(above design '
                                                                                              'value), dry or '
                                                                                              'silted pit, '
                                                                                              'corroded strip, '
                                                                                              'missing cover',
                                                                             'corrective_actions': 'Fix '
                                                                                                   'connections; '
                                                                                                   'add water '
                                                                                                   'only as a '
                                                                                                   'temporary '
                                                                                                   'measure and '
                                                                                                   'do not use '
                                                                                                   'salt '
                                                                                                   '(corrodes '
                                                                                                   'strip/electrode). '
                                                                                                   'Use '
                                                                                                   'chemical/maintenance-free '
                                                                                                   'earthing '
                                                                                                   '(bentonite/GEM) '
                                                                                                   'as a '
                                                                                                   'permanent '
                                                                                                   'fix.',
                                                                             'source_sheet': '4 pole - GSS side',
                                                                             'source_item': 8},
                         'No Chattering Sound Heard in Yard': {'description': 'No chattering sound heard in yard',
                                                               'parameters': 'Listen/ultrasonic scan for '
                                                                             'clicking, buzzing, hissing or '
                                                                             'corona on bushings, isolators, '
                                                                             'jumpers and fuses, especially on '
                                                                             'humid mornings; loose connections '
                                                                             'or faulty relays',
                                                               'abnormalities': 'Unusual clicking or buzzing, '
                                                                                'hissing, blue glow at dusk',
                                                               'corrective_actions': 'Inspect and fix loose '
                                                                                     'components; clean/replace '
                                                                                     'insulator or tighten clamp; '
                                                                                     'inform supplier if source '
                                                                                     'not found.',
                                                               'source_sheet': '4 pole - GSS side',
                                                               'source_item': 9},
                         'Yard Greet Should be Proper': {'description': 'Yard gravel should be proper',
                                                         'parameters': 'Gravel spread evenly (typically 100-150 '
                                                                       'mm), no weed, no muddy patches, no '
                                                                       'waterlogging, drainage and trench covers '
                                                                       'intact',
                                                         'abnormalities': 'Muddy, uneven surface, water '
                                                                          'accumulation, weed growth',
                                                         'corrective_actions': 'Add gravel, level surface, ensure '
                                                                               'proper drainage; use anti-weed '
                                                                               'sheet if needed.',
                                                         'source_sheet': '4 pole - GSS side',
                                                         'source_item': 10},
                         'Fire Bucket Filled with Sand & Fire Extinguisher Filled': {'description': 'Fire bucket '
                                                                                                    'filled with '
                                                                                                    'sand and '
                                                                                                    'fire '
                                                                                                    'extinguisher '
                                                                                                    'filled',
                                                                                     'parameters': 'Sand dry and '
                                                                                                   'full, buckets '
                                                                                                   'and stand '
                                                                                                   'intact, '
                                                                                                   'CO2/DCP '
                                                                                                   'extinguisher '
                                                                                                   'gauge in '
                                                                                                   'green zone, '
                                                                                                   'seal intact, '
                                                                                                   'refill/expiry '
                                                                                                   'date valid, '
                                                                                                   'accessible '
                                                                                                   'and signboard '
                                                                                                   'visible',
                                                                                     'abnormalities': 'Empty '
                                                                                                      'bucket, '
                                                                                                      'wet sand, '
                                                                                                      'expired or '
                                                                                                      'discharged '
                                                                                                      'extinguisher',
                                                                                     'corrective_actions': 'Refill '
                                                                                                           'sand, '
                                                                                                           'replace/refill '
                                                                                                           'extinguisher, '
                                                                                                           'record '
                                                                                                           'expiry '
                                                                                                           'date.',
                                                                                     'source_sheet': '4 pole - '
                                                                                                     'GSS side',
                                                                                     'source_item': 11},
                         'Check horngap Rod and Fuse Condition': {'description': 'Check horn gap rod and fuse '
                                                                                 'condition (DO fuse)',
                                                                  'parameters': 'Fuse colour and carbon deposit '
                                                                                'on rod, fuse link rating '
                                                                                'correct, contacts tight, fuse '
                                                                                'tube/porcelain cracks, horn gap '
                                                                                'setting as per approved drawing, '
                                                                                'hinge and latch free',
                                                                  'abnormalities': 'Fuse turned black, carbon '
                                                                                   'accumulation on '
                                                                                   'bolt/tightness area, loose '
                                                                                   'contacts, gap changed',
                                                                  'corrective_actions': 'Replace fuse if turned '
                                                                                        'black; clean rod where '
                                                                                        'carbon is deposited; '
                                                                                        'tighten contacts; reset '
                                                                                        'gap per drawing (replace '
                                                                                        'damaged parts).',
                                                                  'source_sheet': '4 pole - GSS side',
                                                                  'source_item': 12},
                         'Check the LA is Intact': {'description': 'Check the LA is intact (station type)',
                                                    'parameters': 'Housing clean and uncracked, top and bottom '
                                                                  'clamps tight, earth lead tight and corrosion '
                                                                  'free, surge counter and leakage current '
                                                                  'indicator (if fitted) noted, '
                                                                  'disconnector/insulating base intact',
                                                    'abnormalities': 'Damaged LA, loose connections, counter '
                                                                     'jump, high leakage current, hot spot',
                                                    'corrective_actions': 'Replace damaged LA; tighten '
                                                                          'connections; record counter and '
                                                                          'leakage reading.',
                                                    'source_sheet': '4 pole - GSS side',
                                                    'source_item': 13},
                         'Isolators and earth switch - condition': {'description': 'Isolators and earth switch - '
                                                                                   'condition',
                                                                    'parameters': 'Alignment of blades and fixed '
                                                                                  'contacts, springs and stops, '
                                                                                  'operating handle and lock, '
                                                                                  'interlock between isolator and '
                                                                                  'earth switch/breaker, rubber '
                                                                                  'mat at handle, position '
                                                                                  'indication, insulators clean, '
                                                                                  'gear box and rod earthing',
                                                                    'abnormalities': 'Misalignment, loose bolts, '
                                                                                     'interlock bypass, burnt '
                                                                                     'contacts, missing mat, rust '
                                                                                     'on linkages',
                                                                    'corrective_actions': 'Do not operate if '
                                                                                          'interlock is '
                                                                                          'defective. '
                                                                                          'Realign/tighten under '
                                                                                          'shutdown; call OEM for '
                                                                                          'contacts or interlock '
                                                                                          'repair.',
                                                                    'source_sheet': '4 pole - GSS side',
                                                                    'source_item': 14},
                         'Insulators (post, pin, string) condition': {'description': 'Insulators (post, pin, '
                                                                                     'string) condition',
                                                                      'parameters': 'Cracks, chipping, flashover '
                                                                                    'and tracking marks, glaze '
                                                                                    'loss, cap and pin corrosion, '
                                                                                    'contamination (dust, bird '
                                                                                    'droppings, salt), cemented '
                                                                                    'joints, string hardware and '
                                                                                    'cotter pins',
                                                                      'abnormalities': 'Cracked/chipped units, '
                                                                                       'tracking, heavy deposit, '
                                                                                       'rusted hardware',
                                                                      'corrective_actions': 'Clean with dry cloth '
                                                                                            'under shutdown; '
                                                                                            'replace damaged '
                                                                                            'units; plan '
                                                                                            'pollution cleaning '
                                                                                            'before monsoon.',
                                                                      'source_sheet': '4 pole - GSS side',
                                                                      'source_item': 15},
                         'Dog conductor, jumpers, clamps and connectors': {'description': 'Dog conductor, '
                                                                                          'jumpers, clamps and '
                                                                                          'connectors',
                                                                           'parameters': 'Sag and tension, broken '
                                                                                         'strands/bird-caging, '
                                                                                         'corrosion, bimetallic '
                                                                                         'washers on Al-Cu '
                                                                                         'joints, clamp and bolt '
                                                                                         'tightness (witness '
                                                                                         'marks), spacers, no '
                                                                                         'swinging jumpers; '
                                                                                         'clearances to structure '
                                                                                         'and ground not reduced',
                                                                           'abnormalities': 'Broken strands, '
                                                                                            'loose/burnt clamp, '
                                                                                            'green corrosion, '
                                                                                            'excessive sag',
                                                                           'corrective_actions': 'Retighten or '
                                                                                                 'replace '
                                                                                                 'clamp/connector; '
                                                                                                 'repair or '
                                                                                                 'replace damaged '
                                                                                                 'conductor; '
                                                                                                 're-tension.',
                                                                           'source_sheet': '4 pole - GSS side',
                                                                           'source_item': 16},
                         'I-beam / gantry structure and foundation': {'description': 'I-beam / gantry structure '
                                                                                     'and foundation',
                                                                      'parameters': 'Rust/galvanising loss, bent '
                                                                                    'or missing members, loose or '
                                                                                    'missing nuts and bolts, base '
                                                                                    'plate and anchor bolts, '
                                                                                    'foundation cracks, tilt, '
                                                                                    'anti-climbing device and '
                                                                                    'step bolts',
                                                                      'abnormalities': 'Heavy rust, loose bolts, '
                                                                                       'cracked foundation, '
                                                                                       'leaning structure',
                                                                      'corrective_actions': 'Tighten/replace '
                                                                                            'bolts; paint or '
                                                                                            'zinc-spray touch-up; '
                                                                                            'civil repair; report '
                                                                                            'tilt to engineer.',
                                                                      'source_sheet': '4 pole - GSS side',
                                                                      'source_item': 17},
                         'Earthing strip and earthing connections': {'description': 'Earthing strip and earthing '
                                                                                    'connections',
                                                                     'parameters': 'GI/copper strip joints and '
                                                                                   'bolts tight, no '
                                                                                   'corrosion/damage, equipment '
                                                                                   'earth (two points), structure '
                                                                                   'earth, fence and gate earth, '
                                                                                   'LA earth, neutral earth, '
                                                                                   'strip painted/marked and '
                                                                                   'visible, no theft; '
                                                                                   'below-ground joints sampled '
                                                                                   'by opening a pit',
                                                                     'abnormalities': 'Loose/rusted joint, '
                                                                                      'missing strip, broken '
                                                                                      'bond, bimetallic corrosion',
                                                                     'corrective_actions': 'Tighten, clean and '
                                                                                           'apply anti-corrosion '
                                                                                           'compound or replace '
                                                                                           'strip; report theft; '
                                                                                           'restore continuity.',
                                                                     'source_sheet': '4 pole - GSS side',
                                                                     'source_item': 18},
                         'HT cable route, risers and terminations': {'description': 'HT cable route, risers and '
                                                                                    'terminations',
                                                                     'parameters': 'Cable riser pipe/guard intact '
                                                                                   'and sealed, cable trench/tray '
                                                                                   'covers in place, trench dry, '
                                                                                   'route markers and warning '
                                                                                   'tape, cable support and '
                                                                                   'bending radius, gland and '
                                                                                   'sealing, no rodent entry',
                                                                     'abnormalities': 'Open trench, water in '
                                                                                      'trench, exposed cable, '
                                                                                      'damaged pipe, rodent signs',
                                                                     'corrective_actions': 'Close and drain '
                                                                                           'trench; replace '
                                                                                           'covers and seal '
                                                                                           'entries; protect '
                                                                                           'exposed cable.',
                                                                     'source_sheet': '4 pole - GSS side',
                                                                     'source_item': 19},
                         'CT and PT outdoor MIP': {'description': 'CT and PT outdoor MIP',
                                                   'parameters': 'Terminal box locked and sealed, secondary '
                                                                 'wiring tight, CT secondary not open, PT '
                                                                 'fuse/MCB healthy, DISCOM seal intact, labelling',
                                                   'abnormalities': 'Open or loose secondary, hot terminal, seal '
                                                                    'broken, moisture',
                                                   'corrective_actions': 'Report to HO team and rectification as '
                                                                         'per their guidance',
                                                   'source_sheet': '4 pole - GSS side',
                                                   'source_item': 20},
                         'CT and PT oil level': {'description': 'CT and PT oil level',
                                                 'parameters': 'Oil level shoud me at max level',
                                                 'abnormalities': 'level is lower than max, no level visiblity in '
                                                                  'the tube',
                                                 'corrective_actions': 'Need to fill oil',
                                                 'source_sheet': '4 pole - GSS side',
                                                 'source_item': 21},
                         'ABT meters': {'description': 'ABT meters',
                                        'parameters': 'Display of Main, Check, Standby meters',
                                        'abnormalities': 'Check if display if off when grid is on, all parameters '
                                                         'and readings are ok',
                                        'corrective_actions': 'Contact HO team immediately for any abnormality',
                                        'source_sheet': '4 pole - GSS side',
                                        'source_item': 22},
                         'Lightning protection (mast / shield wire, if provided)': {'description': 'Lightning '
                                                                                                   'protection '
                                                                                                   '(mast / '
                                                                                                   'shield wire, '
                                                                                                   'if provided)',
                                                                                    'parameters': 'Mast and '
                                                                                                  'shield wire '
                                                                                                  'intact, earth '
                                                                                                  'down-conductor '
                                                                                                  'and joints, '
                                                                                                  'test link',
                                                                                    'abnormalities': '',
                                                                                    'corrective_actions': 'Repair/replace; '
                                                                                                          'check '
                                                                                                          'earth '
                                                                                                          'connection.',
                                                                                    'source_sheet': '4 pole - GSS '
                                                                                                    'side',
                                                                                    'source_item': 23},
                         'Bird and animal protection': {'description': 'Bird and animal protection',
                                                        'parameters': 'Nests removed, bird '
                                                                      'spikes/guards/diverters intact, no snake '
                                                                      'or rodent holes in yard or trench',
                                                        'abnormalities': 'Nests on structure or isolator, '
                                                                         'droppings on insulators, burrows',
                                                        'corrective_actions': 'Remove nests safely under '
                                                                              'shutdown; repair guards; seal '
                                                                              'holes.',
                                                        'source_sheet': '4 pole - GSS side',
                                                        'source_item': 24},
                         'Yard lighting, emergency light and signage': {'description': 'Yard lighting, emergency '
                                                                                       'light and signage',
                                                                        'parameters': 'Yard and gate lights '
                                                                                      'working, emergency/torch '
                                                                                      'available, danger boards '
                                                                                      'on structures, SLD, shock '
                                                                                      'treatment chart and '
                                                                                      'equipment labels legible',
                                                                        'abnormalities': 'Light not working, '
                                                                                         'missing or faded board',
                                                                        'corrective_actions': 'Replace '
                                                                                              'lamps/boards; fix '
                                                                                              'cable fault.',
                                                                        'source_sheet': '4 pole - GSS side',
                                                                        'source_item': 25},
                         'Safety items and PPE': {'description': 'Safety items and PPE',
                                                  'parameters': 'HT gloves (test date), rubber mats, insulated '
                                                                'stick/hot-stick if used, earthing rods and '
                                                                'discharge rods, first-aid box, key register',
                                                  'abnormalities': 'Missing item, expired test date, damaged '
                                                                   'glove',
                                                  'corrective_actions': 'Replace/retest; record expiry dates.',
                                                  'source_sheet': '4 pole - GSS side',
                                                  'source_item': 26},
                         'Drainage and monsoon readiness': {'description': 'Drainage and monsoon readiness',
                                                            'parameters': 'Drain channels and culverts clear, no '
                                                                          'erosion near foundations, pit covers '
                                                                          'and trenches above water level',
                                                            'abnormalities': 'Blocked drain, erosion, water '
                                                                             'standing',
                                                            'corrective_actions': 'Clear drains; fill and compact '
                                                                                  'eroded areas.',
                                                            'source_sheet': '4 pole - GSS side',
                                                            'source_item': 27}}}

def guidance_for(equipment: str) -> dict:
    """Return one equipment group only; do not embed it in monthly portfolio payloads."""
    if equipment == "4 Pole + ACDB + Aux. TX":
        groups = [("Four Pole", "Four Pole"), ("Auxiliary Transformer", "IDT Transformer")]
    elif equipment == "GSS visit":
        groups = [("GSS-side VCB & Kiosk", "VCB"), ("GSS-side Switchyard", "GSS-side Switchyard")]
    else:
        return GUIDANCE.get(equipment, {})
    return {prefix + " — " + task: item for prefix, source in groups for task, item in GUIDANCE[source].items()}
